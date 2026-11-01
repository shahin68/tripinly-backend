import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import type { JobsOptions, Queue } from 'bullmq';
import {
  type DomainEvent,
  DomainEvents,
  type DomainEventName,
  OnDomainEvents,
} from '../../common/events/domain-events';
import type { TripChangeKind } from './notification-types';
import {
  NotificationJobs,
  NOTIFICATIONS_QUEUE,
  type PlanInput,
} from './notifications.queue';

const TRIP_CHANGES: Partial<Record<DomainEventName, TripChangeKind>> = {
  [DomainEvents.TRIP_UPDATED]: 'trip_updated',
  [DomainEvents.DAY_CREATED]: 'day_added',
  [DomainEvents.DAY_DELETED]: 'day_deleted',
  [DomainEvents.MARKER_CREATED]: 'place_added',
  [DomainEvents.MARKER_UPDATED]: 'place_updated',
  [DomainEvents.MARKER_DELETED]: 'place_deleted',
  [DomainEvents.MARKERS_REORDERED]: 'places_reordered',
  [DomainEvents.PHOTO_PROCESSING]: 'photo_added',
};

/** Changes that leave a stop to open the push on (a deleted stop has none). */
const STOP_CHANGES = new Set<DomainEventName>([
  DomainEvents.MARKER_CREATED,
  DomainEvents.MARKER_UPDATED,
  DomainEvents.PHOTO_PROCESSING,
]);

const PLAN_JOB: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 1000 },
  // Plans can carry comment text; don't keep them around.
  removeOnComplete: true,
  removeOnFail: { age: 24 * 60 * 60 },
};

/**
 * API side of notifications: turns domain events into compact plan jobs; the
 * worker decides recipients and sends (NotificationPlanner).
 */
@Injectable()
export class NotificationsListener {
  private readonly logger = new Logger(NotificationsListener.name);

  constructor(
    @InjectQueue(NOTIFICATIONS_QUEUE) private readonly queue: Queue,
  ) {}

  @OnEvent(DomainEvents.COMMENT_CREATED)
  onCommentCreated(
    event: DomainEvent<{
      comment: { id: string; markerId: string; body: string };
      markerCreatorId: string | null;
      tripOwnerId: string;
    }>,
  ): Promise<void> {
    const { comment, markerCreatorId, tripOwnerId } = event.data;
    return this.enqueue({
      kind: 'comment_created',
      actorId: event.actorId,
      tripId: event.tripId!,
      markerId: comment.markerId,
      commentId: comment.id,
      body: comment.body,
      recipientIds: [tripOwnerId, markerCreatorId].filter(
        (id): id is string => !!id,
      ),
    });
  }

  @OnEvent(DomainEvents.COMMENT_DELETED)
  onCommentDeleted(event: DomainEvent<{ commentId: string }>): Promise<void> {
    return this.enqueue({
      kind: 'comment_deleted',
      commentId: event.data.commentId,
    });
  }

  @OnEvent(DomainEvents.MEMBER_ADDED)
  onMemberAdded(
    event: DomainEvent<{
      member: { user: { id: string } };
      viaJoinRequest?: boolean;
    }>,
  ): Promise<void> {
    return this.enqueue({
      kind: 'added_to_trip',
      actorId: event.actorId,
      tripId: event.tripId!,
      userIds: [event.data.member.user.id],
      viaJoinRequest: event.data.viaJoinRequest,
    });
  }

  @OnEvent(DomainEvents.USER_FOLLOWED)
  onUserFollowed(event: DomainEvent<{ followeeId: string }>): Promise<void> {
    return this.enqueue({
      kind: 'followed',
      actorId: event.actorId,
      followeeId: event.data.followeeId,
    });
  }

  @OnEvent(DomainEvents.TRIP_SAVED)
  onTripSaved(event: DomainEvent): Promise<void> {
    return this.enqueue({
      kind: 'trip_saved',
      actorId: event.actorId,
      tripId: event.tripId!,
    });
  }

  @OnEvent(DomainEvents.PLACE_HOT_CHANGED)
  onPlaceHotChanged(
    event: DomainEvent<{ placeId: string; hotCount: number; hot?: boolean }>,
  ): Promise<void> {
    // Only a flame given can reach a milestone; the planner checks which.
    if (event.data.hot === false) return Promise.resolve();
    return this.enqueue({
      kind: 'place_hot',
      placeId: event.data.placeId,
      hotCount: event.data.hotCount,
    });
  }

  @OnEvent(DomainEvents.JOIN_REQUESTED)
  onJoinRequested(event: DomainEvent<{ ownerId: string }>): Promise<void> {
    return this.enqueue({
      kind: 'join_requested',
      actorId: event.actorId,
      tripId: event.tripId!,
      ownerId: event.data.ownerId,
    });
  }

  @OnEvent(DomainEvents.TRIP_CREATED)
  onTripCreated(event: DomainEvent<{ memberIds: string[] }>): Promise<void> {
    if (event.data.memberIds.length === 0) return Promise.resolve();
    return this.enqueue({
      kind: 'added_to_trip',
      actorId: event.actorId,
      tripId: event.tripId!,
      userIds: event.data.memberIds,
    });
  }

  @OnDomainEvents(...(Object.keys(TRIP_CHANGES) as DomainEventName[]))
  onTripChanged(event: DomainEvent): Promise<void> {
    const change = TRIP_CHANGES[event.event];
    if (!change || !event.tripId) return Promise.resolve();
    return this.enqueue({
      kind: 'trip_changed',
      actorId: event.actorId,
      tripId: event.tripId,
      change,
      subjectId: changeSubject(event.data),
      markerId: STOP_CHANGES.has(event.event)
        ? changedStop(event.data)
        : undefined,
    });
  }

  @OnEvent(DomainEvents.LIKE_COUNT_CHANGED)
  onLikeCountChanged(
    event: DomainEvent<{
      targetType: string;
      targetId: string;
      liked: boolean;
    }>,
  ): Promise<void> {
    const { targetType, targetId, liked } = event.data;
    // Unlikes never notify, nor do likes without a trip (place images).
    if (!liked || !event.tripId) {
      return Promise.resolve();
    }
    return this.enqueue({
      kind: 'liked',
      actorId: event.actorId,
      targetType: targetType as 'trip' | 'photo' | 'comment',
      targetId,
      tripId: event.tripId,
    });
  }

  private async enqueue(input: PlanInput): Promise<void> {
    try {
      await this.queue.add(NotificationJobs.PLAN, input, PLAN_JOB);
    } catch (error) {
      this.logger.warn(
        `Notification for ${input.kind} not queued: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

/** The stop, day or photo a trip change is about, if the event names one. */
function changeSubject(data: unknown): string | undefined {
  const d = (data ?? {}) as {
    marker?: { id?: string };
    photo?: { id?: string };
    day?: { id?: string };
    markerId?: string;
    dayId?: string;
  };
  return d.marker?.id ?? d.photo?.id ?? d.day?.id ?? d.markerId ?? d.dayId;
}

/** The stop an added or edited stop, or a new photo, belongs to. */
function changedStop(data: unknown): string | undefined {
  const d = (data ?? {}) as {
    marker?: { id?: string };
    photo?: { markerId?: string | null };
  };
  return d.marker?.id ?? d.photo?.markerId ?? undefined;
}
