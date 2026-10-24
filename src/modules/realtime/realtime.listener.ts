import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  type DomainEvent,
  type DomainEventName,
  DomainEvents,
  OnDomainEvents,
} from '../../common/events/domain-events';
import { RealtimePublisher } from './realtime.publisher';
import { type RealtimeMessage, UserEvents } from './realtime.rooms';

/** At most one like.count_changed per target, or place.hot_changed per place, per window, carrying the latest count. */
export const LIKE_EVENT_THROTTLE_MS = 2000;

/** Trip-room events that go out with the service's data as is. */
const PASS_THROUGH = [
  DomainEvents.DAY_CREATED,
  DomainEvents.DAY_DELETED,
  DomainEvents.MARKER_DELETED,
  DomainEvents.MARKERS_REORDERED,
  DomainEvents.MARKER_COVER_CHANGED,
  DomainEvents.PHOTO_FAILED,
  DomainEvents.PHOTO_DELETED,
  DomainEvents.PHOTOS_REORDERED,
  DomainEvents.COMMENT_DELETED,
];

/** Events whose DTO was built for the actor; likedByMe and hotByMe are reset so the payload is viewer-neutral. */
const VIEWER_NEUTRAL = {
  [DomainEvents.MARKER_CREATED]: ['marker', 'hotByMe'],
  [DomainEvents.MARKER_UPDATED]: ['marker', 'hotByMe'],
  [DomainEvents.PHOTO_PROCESSING]: ['photo', 'likedByMe'],
  [DomainEvents.PHOTO_READY]: ['photo', 'likedByMe'],
} as const;

interface CountSlot {
  timer: NodeJS.Timeout;
  pending?: DomainEvent<CountData>;
}

/** A like.count_changed (`targetType`, `targetId`, `count`) or a place.hot_changed (`placeId`, `hotCount`). */
type CountData =
  | { targetType: string; targetId: string; count: number }
  | { placeId: string; hotCount: number };

/**
 * Maps domain events to Socket.IO rooms (the realtime-event skill). Runs in the
 * api and the worker; each handles the events emitted in its own process.
 */
@Injectable()
export class RealtimeListener implements OnModuleDestroy {
  private readonly logger = new Logger(RealtimeListener.name);
  private readonly countSlots = new Map<string, CountSlot>();

  constructor(
    private readonly publisher: RealtimePublisher,
    private readonly prisma: PrismaService,
  ) {}

  onModuleDestroy(): void {
    for (const slot of this.countSlots.values()) clearTimeout(slot.timer);
    this.countSlots.clear();
  }

  @OnDomainEvents(...PASS_THROUGH)
  onTripEvent(event: DomainEvent): Promise<void> {
    return this.safely(event, () => this.toTripOrUploader(event, event.data));
  }

  @OnDomainEvents(...(Object.keys(VIEWER_NEUTRAL) as DomainEventName[]))
  onEntityEvent(event: DomainEvent): Promise<void> {
    return this.safely(event, () => {
      const [key, mine] =
        VIEWER_NEUTRAL[event.event as keyof typeof VIEWER_NEUTRAL];
      const entity = event.data[key] as Record<string, unknown>;
      return this.toTripOrUploader(event, {
        [key]: { ...entity, [mine]: false },
      });
    });
  }

  /**
   * Place photos have no trip room: their uploader hears photo.ready and
   * photo.failed in their own room. Other trip-less events go nowhere.
   */
  private toTripOrUploader(
    event: DomainEvent<unknown>,
    data: unknown,
  ): Promise<void> {
    if (event.tripId) return this.toTrip(event, data);
    if (
      event.actorId &&
      (event.event === DomainEvents.PHOTO_READY ||
        event.event === DomainEvents.PHOTO_FAILED)
    ) {
      this.publisher.toUser(event.actorId, {
        event: event.event,
        tripId: null,
        actorId: event.actorId,
        at: event.at,
        data,
      });
    }
    return Promise.resolve();
  }

  @OnEvent(DomainEvents.COMMENT_CREATED)
  onCommentCreated(event: DomainEvent): Promise<void> {
    return this.safely(event, () =>
      this.toTrip(event, { comment: event.data.comment }),
    );
  }

  @OnEvent(DomainEvents.LIKE_COUNT_CHANGED)
  onLikeCountChanged(event: DomainEvent<CountData>): void {
    if (event.tripId) this.throttleCount(event);
  }

  /** A place's hot count shows on its stops, so it goes to every trip with a stop there. */
  @OnEvent(DomainEvents.PLACE_HOT_CHANGED)
  onPlaceHotChanged(event: DomainEvent<CountData>): void {
    this.throttleCount(event);
  }

  @OnEvent(DomainEvents.TRIP_CREATED)
  onTripCreated(event: DomainEvent<{ memberIds: string[] }>): Promise<void> {
    return this.safely(event, () => {
      for (const userId of new Set([event.actorId, ...event.data.memberIds])) {
        this.tripsChanged(userId, event, 'added');
      }
      return Promise.resolve();
    });
  }

  @OnEvent(DomainEvents.TRIP_UPDATED)
  onTripUpdated(event: DomainEvent): Promise<void> {
    return this.safely(event, async () => {
      await this.toTrip(event, event.data);
      if (event.data.visibility === 'private') {
        const members = await this.prisma.tripMember.findMany({
          where: { tripId: event.tripId },
          select: { userId: true },
        });
        this.publisher.keepOnlyMembers(
          event.tripId!,
          members.map((member) => member.userId),
        );
      }
    });
  }

  @OnEvent(DomainEvents.TRIP_DELETED)
  onTripDeleted(event: DomainEvent<{ memberIds: string[] }>): Promise<void> {
    return this.safely(event, async () => {
      await this.toTrip(event, {});
      this.publisher.clearTrip(event.tripId!);
      for (const userId of event.data.memberIds) {
        this.tripsChanged(userId, event, 'removed');
      }
    });
  }

  @OnEvent(DomainEvents.MEMBER_ADDED)
  onMemberAdded(
    event: DomainEvent<{ member: { user: { id: string } } }>,
  ): Promise<void> {
    return this.safely(event, async () => {
      await this.toTrip(event, event.data);
      this.tripsChanged(event.data.member.user.id, event, 'added');
    });
  }

  @OnEvent(DomainEvents.MEMBER_REMOVED)
  onMemberRemoved(
    event: DomainEvent<{ userId: string; reason: string }>,
  ): Promise<void> {
    return this.safely(event, async () => {
      await this.toTrip(event, event.data);
      this.tripsChanged(event.data.userId, event, 'removed');
      const trip = await this.prisma.trip.findUnique({
        where: { id: event.tripId },
        select: { visibility: true },
      });
      // A former editor may keep watching a public trip, unless a block ended it.
      if (event.data.reason === 'blocked' || trip?.visibility !== 'public') {
        this.publisher.evictFromTrip(event.tripId!, [event.data.userId]);
      }
    });
  }

  @OnEvent(DomainEvents.USER_BLOCKED)
  onUserBlocked(event: DomainEvent<{ blockedId: string }>): Promise<void> {
    return this.safely(event, async () => {
      const blockerId = event.actorId;
      const { blockedId } = event.data;
      const trips = await this.prisma.trip.findMany({
        where: { ownerId: { in: [blockerId, blockedId] } },
        select: { id: true, ownerId: true },
      });
      const ownedBy = (ownerId: string) =>
        trips.filter((trip) => trip.ownerId === ownerId).map((t) => t.id);
      this.publisher.leaveTrips(blockedId, ownedBy(blockerId));
      this.publisher.leaveTrips(blockerId, ownedBy(blockedId));
    });
  }

  /** Both people's counts and lists changed, so both hear it (on every device). */
  @OnDomainEvents(DomainEvents.USER_FOLLOWED, DomainEvents.USER_UNFOLLOWED)
  onFollowChanged(event: DomainEvent<{ followeeId: string }>): Promise<void> {
    return this.safely(event, () => {
      const followerId = event.actorId;
      const { followeeId } = event.data;
      const message: RealtimeMessage = {
        event: UserEvents.FOLLOWS_CHANGED,
        tripId: null,
        actorId: followerId,
        at: event.at,
        data: {
          followerId,
          followeeId,
          following: event.event === DomainEvents.USER_FOLLOWED,
        },
      };
      this.publisher.toUser(followerId, message);
      this.publisher.toUser(followeeId, message);
      return Promise.resolve();
    });
  }

  /**
   * Suspension or deletion: their live sockets close at once. A suspended
   * user is told first so the app can explain why.
   */
  @OnEvent(DomainEvents.ACCOUNT_CLOSED)
  onAccountClosed(
    event: DomainEvent<{ userId: string; reason: 'suspended' | 'deleted' }>,
  ): Promise<void> {
    return this.safely(event, () => {
      const { userId, reason } = event.data;
      if (reason === 'suspended') {
        this.publisher.toUser(userId, {
          event: UserEvents.ACCOUNT_SUSPENDED,
          tripId: null,
          actorId: null,
          at: event.at,
          data: {},
        });
      }
      this.publisher.disconnectUser(userId);
      return Promise.resolve();
    });
  }

  private toTrip(event: DomainEvent<unknown>, data: unknown): Promise<void> {
    return this.publisher.toTrip({
      event: event.event,
      tripId: event.tripId!,
      actorId: event.actorId,
      at: event.at,
      data,
    });
  }

  private tripsChanged(
    userId: string,
    event: DomainEvent,
    change: 'added' | 'removed',
  ): void {
    const message: RealtimeMessage = {
      event: UserEvents.TRIPS_CHANGED,
      tripId: event.tripId ?? null,
      actorId: event.actorId,
      at: event.at,
      data: { tripId: event.tripId, change },
    };
    this.publisher.toUser(userId, message);
  }

  /** Leading edge goes out at once; later changes in the window collapse into one trailing event. */
  private throttleCount(event: DomainEvent<CountData>): void {
    const { data } = event;
    const key =
      'placeId' in data
        ? `place:${data.placeId}`
        : `${data.targetType}:${data.targetId}`;
    const slot = this.countSlots.get(key);
    if (slot) {
      slot.pending = event;
      return;
    }
    const timer = setTimeout(() => {
      const pending = this.countSlots.get(key)?.pending;
      this.countSlots.delete(key);
      if (pending) this.throttleCount(pending);
    }, LIKE_EVENT_THROTTLE_MS);
    timer.unref();
    this.countSlots.set(key, { timer });
    void this.safely(event, async () => {
      if (!('placeId' in data)) {
        const { targetType, targetId, count } = data;
        return this.toTrip(event, { targetType, targetId, count });
      }
      const stops = await this.prisma.marker.findMany({
        where: { placeId: data.placeId, hiddenAt: null },
        select: { tripId: true },
        distinct: ['tripId'],
      });
      for (const { tripId } of stops) {
        await this.toTrip({ ...event, tripId }, data);
      }
    });
  }

  private async safely(
    event: DomainEvent<unknown>,
    send: () => Promise<void>,
  ): Promise<void> {
    try {
      await send();
    } catch (error) {
      this.logger.warn(
        `Realtime ${event.event} not delivered: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
