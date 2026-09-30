import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { PrismaService } from '../../common/prisma/prisma.service';
import { type NotificationType, Prisma } from '../../generated/prisma/client';
import { BlocksService } from '../moderation/blocks.service';
import { TripAccessService } from '../trips/trip-access.service';
import { NotificationPublisher } from './notification-publisher';
import { NotificationTimings } from './notification-timings';
import {
  type CommentPayload,
  excerpt,
  GROUP_ID_CAP,
  LIKERS_CAP,
  type LikesPayload,
  type TripChangesPayload,
} from './notification-types';
import {
  DELIVERY_RETRIES,
  flushJobId,
  NotificationJobs,
  NOTIFICATIONS_QUEUE,
  type PlanInput,
  pushJobId,
} from './notifications.queue';

interface GroupUpdate<P> {
  payload: P;
  count: number;
}

/**
 * Decides who hears about a domain event (the notifications skill): never the
 * actor, never across a block, only people who can still see the trip. Writes
 * the in-app rows and schedules pushes: immediately for comments and
 * invitations, batched for collaborator changes, grouped for likes.
 */
@Injectable()
export class NotificationPlanner {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TripAccessService,
    private readonly publisher: NotificationPublisher,
    private readonly timings: NotificationTimings,
    @InjectQueue(NOTIFICATIONS_QUEUE) private readonly queue: Queue,
  ) {}

  async plan(input: PlanInput): Promise<void> {
    switch (input.kind) {
      case 'comment_created':
        return this.commentCreated(input);
      case 'comment_deleted':
        await this.prisma.notification.deleteMany({
          where: {
            type: 'comment_on_marker',
            payload: { path: ['commentId'], equals: input.commentId },
          },
        });
        return;
      case 'added_to_trip':
        return this.addedToTrip(input);
      case 'trip_changed':
        return this.tripChanged(input);
      case 'liked':
        return this.liked(input);
    }
  }

  private async commentCreated(
    input: Extract<PlanInput, { kind: 'comment_created' }>,
  ): Promise<void> {
    const marker = await this.prisma.marker.findUnique({
      where: { id: input.markerId },
      select: { name: true },
    });
    if (!marker) return;
    const payload: CommentPayload = {
      commentId: input.commentId,
      markerName: marker.name,
      excerpt: excerpt(input.body),
    };
    for (const recipientId of await this.eligible(
      input.actorId,
      input.tripId,
      input.recipientIds,
    )) {
      await this.immediate({
        recipientId,
        type: 'comment_on_marker',
        actorId: input.actorId,
        tripId: input.tripId,
        markerId: input.markerId,
        payload: payload as unknown as Prisma.InputJsonObject,
      });
    }
  }

  private async addedToTrip(
    input: Extract<PlanInput, { kind: 'added_to_trip' }>,
  ): Promise<void> {
    for (const recipientId of await this.eligible(
      input.actorId,
      input.tripId,
      input.userIds,
    )) {
      await this.immediate({
        recipientId,
        type: 'added_to_trip',
        actorId: input.actorId,
        tripId: input.tripId,
      });
    }
  }

  private async tripChanged(
    input: Extract<PlanInput, { kind: 'trip_changed' }>,
  ): Promise<void> {
    const members = await this.prisma.tripMember.findMany({
      where: { tripId: input.tripId },
      select: { userId: true },
    });
    const recipients = await this.eligible(
      input.actorId,
      input.tripId,
      members.map((member) => member.userId),
    );
    for (const recipientId of recipients) {
      await this.collect<TripChangesPayload>({
        recipientId,
        type: 'trip_changed_by_collaborator',
        groupKey: `changes:${input.tripId}:${recipientId}`,
        actorId: input.actorId,
        tripId: input.tripId,
        windowMs: this.timings.collaboratorBatchMs,
        merge: (current, count) => ({
          payload: {
            actorIds: frontOf(current?.actorIds, input.actorId, GROUP_ID_CAP),
            kinds: {
              ...current?.kinds,
              [input.change]: (current?.kinds[input.change] ?? 0) + 1,
            },
          },
          count: count + 1,
        }),
      });
    }
  }

  private async liked(
    input: Extract<PlanInput, { kind: 'liked' }>,
  ): Promise<void> {
    const ownerId = await this.likedItemOwner(input.targetType, input.targetId);
    if (!ownerId) return;
    const [recipientId] = await this.eligible(input.actorId, input.tripId, [
      ownerId,
    ]);
    if (!recipientId) return;
    await this.collect<LikesPayload>({
      recipientId,
      type: 'likes_grouped',
      groupKey: `likes:${recipientId}`,
      actorId: input.actorId,
      tripId: input.tripId,
      windowMs: this.timings.likesWindowMs,
      merge: (current) => {
        const likerIds = current?.likerIds ?? [];
        // A like, unlike and like again by the same person counts once.
        if (likerIds.includes(input.actorId)) return undefined;
        const nextLikers = [input.actorId, ...likerIds].slice(0, LIKERS_CAP);
        const tripIds = current?.tripIds ?? [];
        return {
          payload: {
            likerIds: nextLikers,
            tripIds: tripIds.includes(input.tripId)
              ? tripIds
              : [...tripIds, input.tripId].slice(0, GROUP_ID_CAP),
          },
          count: nextLikers.length,
        };
      },
    });
  }

  /** Who gets the likes for an item: whoever posted it. */
  private async likedItemOwner(
    targetType: Extract<PlanInput, { kind: 'liked' }>['targetType'],
    targetId: string,
  ): Promise<string | null> {
    switch (targetType) {
      case 'trip':
        return (
          (
            await this.prisma.trip.findUnique({
              where: { id: targetId },
              select: { ownerId: true },
            })
          )?.ownerId ?? null
        );
      case 'marker':
        return (
          (
            await this.prisma.marker.findUnique({
              where: { id: targetId },
              select: { createdById: true },
            })
          )?.createdById ?? null
        );
      case 'photo':
        return (
          (
            await this.prisma.photo.findUnique({
              where: { id: targetId },
              select: { uploaderId: true },
            })
          )?.uploaderId ?? null
        );
      case 'comment':
        return (
          (
            await this.prisma.comment.findUnique({
              where: { id: targetId },
              select: { authorId: true },
            })
          )?.authorId ?? null
        );
    }
  }

  /**
   * Candidates minus the actor, anyone with a block either way with the actor,
   * inactive accounts, and anyone who can no longer see the trip.
   */
  private async eligible(
    actorId: string,
    tripId: string,
    candidateIds: (string | null)[],
  ): Promise<string[]> {
    const ids = [
      ...new Set(candidateIds.filter((id): id is string => !!id)),
    ].filter((id) => id !== actorId);
    if (ids.length === 0) return [];
    const [blocked, active] = await Promise.all([
      BlocksService.blockedAmong(this.prisma, actorId, ids),
      this.prisma.user.findMany({
        where: { id: { in: ids }, status: 'active' },
        select: { id: true },
      }),
    ]);
    const result: string[] = [];
    for (const { id } of active) {
      if (blocked.has(id)) continue;
      if (await this.canView(id, tripId)) result.push(id);
    }
    return result;
  }

  private async canView(userId: string, tripId: string): Promise<boolean> {
    try {
      await this.access.assert(userId, tripId, 'view');
      return true;
    } catch {
      return false;
    }
  }

  private async immediate(data: {
    recipientId: string;
    type: NotificationType;
    actorId: string;
    tripId: string;
    markerId?: string;
    payload?: Prisma.InputJsonObject;
  }): Promise<void> {
    const row = await this.prisma.notification.create({
      data: { ...data, payload: data.payload ?? {} },
    });
    await this.queue.add(
      NotificationJobs.PUSH,
      { notificationId: row.id },
      { ...DELIVERY_RETRIES, jobId: pushJobId(row.id) },
    );
    await this.publisher.publish(row.id);
  }

  /**
   * Adds to the recipient's open group for this key, or opens one and
   * schedules its flush after the window. merge returns undefined when the
   * event changes nothing (a repeat like).
   */
  private async collect<P>(options: {
    recipientId: string;
    type: NotificationType;
    groupKey: string;
    actorId: string;
    tripId: string;
    windowMs: number;
    merge: (
      current: P | undefined,
      count: number,
    ) => GroupUpdate<P> | undefined;
  }): Promise<void> {
    const open = await this.prisma.notification.findFirst({
      where: { groupKey: options.groupKey, pushedAt: null },
    });
    if (open) {
      const next = options.merge(open.payload as P, open.count);
      if (!next) return;
      const tripIds = (next.payload as { tripIds?: string[] }).tripIds;
      const updated = await this.prisma.notification.updateMany({
        // Only while still open; a flush may have closed it since we read it.
        where: { id: open.id, pushedAt: null },
        data: {
          payload: next.payload as Prisma.InputJsonObject,
          count: next.count,
          actorId: options.actorId,
          // Likes across several trips belong to no single trip.
          tripId: tripIds && tripIds.length > 1 ? null : open.tripId,
          readAt: null,
        },
      });
      if (updated.count === 1) {
        await this.publisher.publish(open.id);
        return;
      }
    }
    const first = options.merge(undefined, 0);
    if (!first) return;
    // A concurrent worker opening the same group trips the partial unique
    // index; the job then retries and joins that group.
    const row = await this.prisma.notification.create({
      data: {
        recipientId: options.recipientId,
        type: options.type,
        actorId: options.actorId,
        tripId: options.tripId,
        groupKey: options.groupKey,
        payload: first.payload as Prisma.InputJsonObject,
        count: first.count,
      },
    });
    await this.queue.add(
      NotificationJobs.FLUSH,
      { notificationId: row.id },
      {
        ...DELIVERY_RETRIES,
        jobId: flushJobId(row.id),
        delay: options.windowMs,
      },
    );
    await this.publisher.publish(row.id);
  }
}

/** ids with `id` moved to the front, without duplicates, capped. */
function frontOf(ids: string[] | undefined, id: string, cap: number): string[] {
  return [id, ...(ids ?? []).filter((other) => other !== id)].slice(0, cap);
}
