import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Env } from '../../common/config/env';
import { PrismaService } from '../../common/prisma/prisma.service';
import { REDIS } from '../../common/redis/redis.module';
import { type NotificationType, Prisma } from '../../generated/prisma/client';
import { BlocksService } from '../moderation/blocks.service';
import { TripAccessService } from '../trips/trip-access.service';
import { NotificationPublisher } from './notification-publisher';
import {
  COMMENT_TYPES,
  type CommentPayload,
  excerpt,
  FOLLOW_REPEAT_SECONDS,
  type GroupPayload,
  type LikesPayload,
  type MembershipPayload,
  milestoneReached,
  type PlaceHotPayload,
  type TripChangesPayload,
} from './notification-types';
import {
  DELIVERY_RETRIES,
  NotificationJobs,
  NOTIFICATIONS_QUEUE,
  type PlanInput,
  pushJobId,
} from './notifications.queue';

/**
 * Decides who hears about a domain event (the notifications skill): never the
 * actor, never across a block, only people who can still see the trip. Writes
 * the in-app row (the notification center) and sends its push at once
 * (Shahin, 2026-11-01), except: likes on trips and photos and flames push
 * only at APP_NOTIFICATION_MILESTONES, saves never push, and a follow pushes
 * once per pair (Shahin, 2026-11-07). Most types group (Shahin, 2026-11-07):
 * one row per stop's comments, comment thread, stop or trip changed, trip
 * saved, liked item, flamed spot and for follows, growing until it is read
 * (tapped, or its stop opened); then the next one starts a new row. Mentions
 * and membership notices stay single. The same thing again from the same
 * person (a like, unlike and like; the same stop moved twice) within
 * NOTIFICATION_REPEAT_COOLDOWN_SECONDS is dropped.
 */
@Injectable()
export class NotificationPlanner {
  private readonly logger = new Logger(NotificationPlanner.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TripAccessService,
    private readonly publisher: NotificationPublisher,
    private readonly config: ConfigService<Env, true>,
    @Inject(REDIS) private readonly redis: Redis,
    @InjectQueue(NOTIFICATIONS_QUEUE) private readonly queue: Queue,
  ) {}

  async plan(input: PlanInput): Promise<void> {
    switch (input.kind) {
      case 'comment_created':
        return this.commentCreated(input);
      case 'comment_deleted':
        return this.commentDeleted(input.commentId);
      case 'added_to_trip':
        return this.addedToTrip(input);
      case 'join_requested':
        return this.joinRequested(input);
      case 'trip_changed':
        return this.tripChanged(input);
      case 'liked':
        return this.liked(input);
      case 'followed':
        return this.followed(input);
      case 'trip_saved':
        return this.tripSaved(input);
      case 'place_hot':
        return this.placeHot(input);
      case 'join_declined':
      case 'removed_from_trip':
        return this.membershipEnded(input);
    }
  }

  /**
   * Everyone on the trip and everyone who commented on the stop gets the
   * notification (the stop's red dot, the center). The push goes to the same
   * people for a main comment, and to the thread (the main comment's author
   * and its repliers) for a reply. A comment that @mentions someone pushes to
   * the mentioned people only.
   */
  private async commentCreated(
    input: Extract<PlanInput, { kind: 'comment_created' }>,
  ): Promise<void> {
    const parentId = input.parentId ?? null;
    const mentionIds = input.mentionIds ?? [];
    const [marker, members, commenters, thread] = await Promise.all([
      this.prisma.marker.findUnique({
        where: { id: input.markerId },
        select: { name: true },
      }),
      this.prisma.tripMember.findMany({
        where: { tripId: input.tripId },
        select: { userId: true },
      }),
      this.prisma.comment.findMany({
        where: { markerId: input.markerId },
        distinct: ['authorId'],
        select: { authorId: true },
      }),
      parentId
        ? this.prisma.comment.findMany({
            where: { OR: [{ id: parentId }, { parentId }] },
            distinct: ['authorId'],
            select: { authorId: true },
          })
        : [],
    ]);
    if (!marker) return;
    const payload: CommentPayload = {
      commentId: input.commentId,
      markerName: marker.name,
      excerpt: excerpt(input.body),
    };
    // Null: everyone who gets the row.
    const pushTo =
      mentionIds.length > 0
        ? new Set(mentionIds)
        : parentId
          ? new Set(thread.map((comment) => comment.authorId))
          : null;
    for (const recipientId of await this.eligible(input.actorId, input.tripId, [
      ...members.map((member) => member.userId),
      ...commenters.map((comment) => comment.authorId),
    ])) {
      const push = pushTo === null || pushTo.has(recipientId);
      const data = {
        recipientId,
        actorId: input.actorId,
        tripId: input.tripId,
        markerId: input.markerId,
        payload: payload as unknown as Prisma.InputJsonObject,
      };
      if (mentionIds.includes(recipientId)) {
        await this.immediate({ ...data, type: 'comment_mention' }, push);
        continue;
      }
      // A stop's comments, or one thread's replies, gather in one row.
      await this.grouped(
        { ...data, type: parentId ? 'comment_reply' : 'comment_on_marker' },
        parentId
          ? `replies:${parentId}:${recipientId}`
          : `comments:${input.markerId}:${recipientId}`,
        {
          push: push ? 'always' : 'never',
          merge: (old) => ({
            ...payload,
            commentIds: [
              ...((old as Partial<CommentPayload>).commentIds ??
                [(old as Partial<CommentPayload>).commentId].filter(
                  (id): id is string => !!id,
                )),
              input.commentId,
            ],
          }),
        },
      );
    }
  }

  /**
   * A deleted comment leaves the rows about it: a single one goes, a group
   * shrinks to the comments still there (their latest text and people) or
   * goes when none is left. Likes on it go too.
   */
  private async commentDeleted(commentId: string): Promise<void> {
    const rows = await this.prisma.notification.findMany({
      where: {
        type: { in: [...COMMENT_TYPES] },
        OR: [
          { payload: { path: ['commentId'], equals: commentId } },
          { payload: { path: ['commentIds'], array_contains: [commentId] } },
        ],
      },
      select: { id: true, payload: true },
    });
    for (const row of rows) {
      const payload = row.payload as unknown as CommentPayload;
      const ids = (payload.commentIds ?? [payload.commentId]).filter(
        (id) => id !== commentId,
      );
      const left = ids.length
        ? await this.prisma.comment.findMany({
            where: { id: { in: ids } },
            orderBy: { createdAt: 'asc' },
            select: { id: true, authorId: true, body: true },
          })
        : [];
      const latest = left.at(-1);
      if (!latest) {
        await this.prisma.notification.delete({ where: { id: row.id } });
        continue;
      }
      const actorIds = [
        ...new Set(
          left
            .map((comment) => comment.authorId)
            .filter((id): id is string => !!id)
            .reverse(),
        ),
      ];
      await this.prisma.notification.update({
        where: { id: row.id },
        data: {
          count: left.length,
          actorId: actorIds[0] ?? null,
          payload: {
            ...payload,
            commentId: latest.id,
            commentIds: left.map((comment) => comment.id),
            excerpt: excerpt(latest.body),
            actorIds,
          },
        },
      });
    }
    await this.prisma.notification.deleteMany({
      where: { groupKey: { startsWith: likesKey('comment', commentId) } },
    });
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
        type: input.viaJoinRequest ? 'join_accepted' : 'added_to_trip',
        actorId: input.actorId,
        tripId: input.tripId,
      });
    }
  }

  private async joinRequested(
    input: Extract<PlanInput, { kind: 'join_requested' }>,
  ): Promise<void> {
    const [recipientId] = await this.eligible(input.actorId, input.tripId, [
      input.ownerId,
    ]);
    if (!recipientId) return;
    await this.immediate({
      recipientId,
      type: 'join_requested',
      actorId: input.actorId,
      tripId: input.tripId,
    });
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
    const payload: TripChangesPayload = {
      actorIds: [input.actorId],
      kinds: { [input.change]: 1 },
    };
    const markerId = await this.existingStop(input.markerId);
    for (const recipientId of recipients) {
      if (
        !(await this.isFirstInCooldown(
          `${recipientId}:${input.actorId}:${input.change}:${input.subjectId ?? input.tripId}`,
        ))
      ) {
        continue;
      }
      // One row per changed stop (its "new" mark clears with it), and one for the trip's other changes.
      await this.grouped(
        {
          recipientId,
          type: 'trip_changed_by_collaborator',
          actorId: input.actorId,
          tripId: input.tripId,
          markerId,
          payload: payload as unknown as Prisma.InputJsonObject,
        },
        `changes:${input.tripId}:${markerId ?? 'trip'}:${recipientId}`,
        {
          push: 'always',
          merge: (old) => {
            const kinds = { ...(old as Partial<TripChangesPayload>).kinds };
            kinds[input.change] = (kinds[input.change] ?? 0) + 1;
            return { kinds };
          },
        },
      );
    }
  }

  /**
   * One entry per liked item for whoever posted it, showing the latest liker
   * and the count. A comment like pushes each time; trip and photo likes push
   * only when the count reaches a milestone, once each.
   */
  private async liked(
    input: Extract<PlanInput, { kind: 'liked' }>,
  ): Promise<void> {
    const item = await this.likedItem(input.targetType, input.targetId);
    if (!item) return;
    const [recipientId] = await this.eligible(input.actorId, input.tripId, [
      item.ownerId,
    ]);
    if (!recipientId) return;
    const isComment = input.targetType === 'comment';
    if (
      isComment &&
      !(await this.isFirstInCooldown(
        `${recipientId}:${input.actorId}:like:${input.targetType}:${input.targetId}`,
      ))
    ) {
      return;
    }
    const payload: LikesPayload = {
      likerIds: [input.actorId],
      tripIds: input.tripId ? [input.tripId] : [],
      targetType: input.targetType,
      ...(item.markerName === undefined ? {} : { markerName: item.markerName }),
      ...(item.excerpt === undefined ? {} : { excerpt: item.excerpt }),
    };
    await this.grouped(
      {
        recipientId,
        type: 'likes_grouped',
        actorId: input.actorId,
        tripId: input.tripId,
        markerId: item.markerId,
        payload: payload as unknown as Prisma.InputJsonObject,
      },
      `${likesKey(input.targetType, input.targetId)}:${recipientId}`,
      { count: input.count ?? 1, push: isComment ? 'always' : 'milestones' },
    );
  }

  /**
   * "Anna followed you", once per pair ever, or "You and Anna are now
   * friends" when I already follow Anna, at most once per pair per day, so
   * following and unfollowing can't spam anyone.
   */
  private async followed(
    input: Extract<PlanInput, { kind: 'followed' }>,
  ): Promise<void> {
    const { actorId, followeeId: recipientId } = input;
    const [follows, blocked, recipient] = await Promise.all([
      this.prisma.follow.findMany({
        where: {
          OR: [
            { followerId: actorId, followeeId: recipientId },
            { followerId: recipientId, followeeId: actorId },
          ],
        },
        select: { followerId: true },
      }),
      BlocksService.blockedAmong(this.prisma, actorId, [recipientId]),
      this.prisma.user.findUnique({
        where: { id: recipientId },
        select: { status: true },
      }),
    ]);
    // Unfollowed again before the job ran, a block, or gone: nothing to say.
    if (!follows.some((follow) => follow.followerId === actorId)) return;
    if (blocked.size > 0 || recipient?.status !== 'active') return;
    const friends = follows.some((follow) => follow.followerId === recipientId);
    const type = friends ? 'became_friends' : 'followed';
    if (
      type === 'followed' &&
      (await this.prisma.notification.findFirst({
        where: {
          recipientId,
          type,
          OR: [
            { actorId },
            { payload: { path: ['actorIds'], array_contains: [actorId] } },
          ],
        },
        select: { id: true },
      }))
    ) {
      return;
    }
    if (
      type === 'became_friends' &&
      !(await this.isFirstInCooldown(
        `${recipientId}:${actorId}:${type}`,
        FOLLOW_REPEAT_SECONDS,
      ))
    ) {
      return;
    }
    if (type === 'became_friends') {
      await this.immediate({ recipientId, type, actorId });
      return;
    }
    await this.grouped(
      { recipientId, type, actorId, payload: {} },
      `follows:${recipientId}`,
      { push: 'always' },
    );
  }

  /** "Anna saved your trip", to the owner, in the center only; repeats within the cooldown are dropped. */
  private async tripSaved(
    input: Extract<PlanInput, { kind: 'trip_saved' }>,
  ): Promise<void> {
    const trip = await this.prisma.trip.findUnique({
      where: { id: input.tripId },
      select: { ownerId: true },
    });
    if (!trip) return;
    const [recipientId] = await this.eligible(input.actorId, input.tripId, [
      trip.ownerId,
    ]);
    if (!recipientId) return;
    if (
      !(await this.isFirstInCooldown(
        `${recipientId}:${input.actorId}:saved:${input.tripId}`,
      ))
    ) {
      return;
    }
    await this.grouped(
      {
        recipientId,
        type: 'trip_saved',
        actorId: input.actorId,
        tripId: input.tripId,
        payload: {},
      },
      `saves:${input.tripId}:${recipientId}`,
      { push: 'never' },
    );
  }

  /**
   * A flame on a spot someone made themselves: its creator, and only its
   * creator, has one entry per spot with the latest flame and the count, and
   * hears that it's getting hot at each milestone, once. No per-flame pushes
   * (Shahin, 2026-11-01: pushes cost money). The entry opens the creator's
   * own stop at that spot when they have one.
   */
  private async placeHot(
    input: Extract<PlanInput, { kind: 'place_hot' }>,
  ): Promise<void> {
    const place = await this.prisma.place.findUnique({
      where: { id: input.placeId },
      select: { name: true, createdById: true },
    });
    if (!place?.createdById) return;
    const [recipientId] = input.actorId
      ? await this.eligible(input.actorId, undefined, [place.createdById])
      : [place.createdById];
    if (!recipientId) return;
    const stop = await this.creatorsStop(recipientId, input.placeId);
    const payload: PlaceHotPayload = {
      placeId: input.placeId,
      placeName: place.name,
    };
    await this.grouped(
      {
        recipientId,
        type: 'place_hot',
        actorId: input.actorId,
        tripId: stop?.tripId,
        markerId: stop?.id,
        payload: payload as unknown as Prisma.InputJsonObject,
      },
      `hot:${input.placeId}:${recipientId}`,
      { count: input.hotCount, push: 'milestones' },
    );
  }

  /**
   * "Anna declined your request" or "Anna removed you from Rome": once, to
   * that person, even though they can't see the trip any more (its name is in
   * the payload).
   */
  private async membershipEnded(
    input: Extract<PlanInput, { kind: 'join_declined' | 'removed_from_trip' }>,
  ): Promise<void> {
    const [[recipientId], trip] = await Promise.all([
      this.eligible(input.actorId, undefined, [input.userId]),
      this.prisma.trip.findUnique({
        where: { id: input.tripId },
        select: { title: true },
      }),
    ]);
    if (!recipientId || !trip) return;
    const payload: MembershipPayload = {
      tripId: input.tripId,
      tripTitle: trip.title,
    };
    await this.immediate({
      recipientId,
      type: input.kind,
      actorId: input.actorId,
      payload: payload as unknown as Prisma.InputJsonObject,
    });
  }

  /** The creator's newest stop at a spot, on a trip they can still see. */
  private async creatorsStop(
    userId: string,
    placeId: string,
  ): Promise<{ id: string; tripId: string } | null> {
    const stops = await this.prisma.marker.findMany({
      where: { placeId, trip: { members: { some: { userId } } } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, tripId: true },
      take: 1,
    });
    return stops[0] ?? null;
  }

  /** The stop, if it still exists (it may be deleted before the job runs). */
  private async existingStop(markerId?: string): Promise<string | undefined> {
    if (!markerId) return undefined;
    const marker = await this.prisma.marker.findUnique({
      where: { id: markerId },
      select: { id: true },
    });
    return marker?.id;
  }

  /**
   * True for the first of identical notifications within the cooldown, so a
   * like, unlike and like again pushes once. If Redis can't answer, it sends.
   */
  private async isFirstInCooldown(
    key: string,
    seconds = this.config.get('NOTIFICATION_REPEAT_COOLDOWN_SECONDS', {
      infer: true,
    }),
  ): Promise<boolean> {
    if (seconds === 0) return true;
    try {
      return (
        (await this.redis.set(
          `notifications:repeat:${key}`,
          '1',
          'EX',
          seconds,
          'NX',
        )) === 'OK'
      );
    } catch (error) {
      this.logger.warn(
        `Repeat check skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
      return true;
    }
  }

  /**
   * Who gets the likes for an item (whoever posted it), and what the push
   * names: the stop of a photo or comment, and a comment's text.
   */
  private async likedItem(
    targetType: Extract<PlanInput, { kind: 'liked' }>['targetType'],
    targetId: string,
  ): Promise<{
    ownerId: string;
    markerId?: string;
    markerName?: string;
    excerpt?: string;
  } | null> {
    switch (targetType) {
      case 'trip': {
        const trip = await this.prisma.trip.findUnique({
          where: { id: targetId },
          select: { ownerId: true },
        });
        return trip && { ownerId: trip.ownerId };
      }
      case 'photo': {
        const photo = await this.prisma.photo.findUnique({
          where: { id: targetId },
          select: {
            uploaderId: true,
            marker: { select: { id: true, name: true } },
            place: { select: { name: true } },
          },
        });
        if (!photo?.uploaderId) return null;
        // A photo in a place's gallery is named after the place.
        return {
          ownerId: photo.uploaderId,
          markerId: photo.marker?.id,
          markerName: photo.marker?.name ?? photo.place?.name,
        };
      }
      case 'comment': {
        const comment = await this.prisma.comment.findUnique({
          where: { id: targetId },
          select: {
            authorId: true,
            body: true,
            marker: { select: { id: true, name: true } },
          },
        });
        if (!comment?.authorId) return null;
        return {
          ownerId: comment.authorId,
          markerId: comment.marker.id,
          markerName: comment.marker.name,
          excerpt: excerpt(comment.body),
        };
      }
    }
  }

  /**
   * Candidates minus the actor, anyone with a block either way with the actor,
   * inactive accounts, and anyone who can no longer see the trip (when there
   * is one).
   */
  private async eligible(
    actorId: string,
    tripId: string | undefined,
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
      if (!tripId || (await this.canView(id, tripId))) result.push(id);
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

  /**
   * Adds to the open (unread) row under [groupKey], or starts one: the latest
   * person first, [count] (else one more), back on top of the center. The
   * push goes out each time, never, or only when [count] reaches the next
   * milestone (remembered across the key's rows, so a new row after a read
   * one doesn't push a milestone twice). [merge] combines the open row's
   * payload with this one's.
   */
  private async grouped(
    data: {
      recipientId: string;
      type: NotificationType;
      actorId?: string;
      tripId?: string;
      markerId?: string;
      payload: Prisma.InputJsonObject;
    },
    groupKey: string,
    options: {
      count?: number;
      push: 'always' | 'never' | 'milestones';
      merge?: (old: Prisma.JsonObject) => Prisma.InputJsonObject;
    },
  ): Promise<void> {
    const [open, last] = await Promise.all([
      this.prisma.notification.findFirst({
        where: { groupKey, readAt: null },
        orderBy: { createdAt: 'desc' },
        select: { id: true, payload: true, count: true },
      }),
      options.push === 'milestones'
        ? this.prisma.notification.findFirst({
            where: { groupKey },
            orderBy: { createdAt: 'desc' },
            select: { payload: true },
          })
        : null,
    ]);
    const old = (open?.payload ?? {}) as Prisma.JsonObject;
    const count = options.count ?? (open ? open.count + 1 : 1);
    const pushed = (last?.payload as { milestone?: number } | undefined)
      ?.milestone;
    const milestone =
      options.push === 'milestones'
        ? milestoneReached(
            count,
            this.config.get('APP_NOTIFICATION_MILESTONES', { infer: true }),
            pushed,
          )
        : undefined;
    const actorIds = [
      ...new Set(
        [data.actorId, ...((old as GroupPayload).actorIds ?? [])].filter(
          (id): id is string => !!id,
        ),
      ),
    ];
    const payload = {
      ...data.payload,
      ...(open && options.merge ? options.merge(old) : {}),
      actorIds,
      ...((milestone ?? pushed) === undefined
        ? {}
        : { milestone: milestone ?? pushed }),
    };
    const fields = {
      ...data,
      actorId: data.actorId ?? null,
      tripId: data.tripId ?? null,
      markerId: data.markerId ?? null,
      payload,
      count,
      createdAt: new Date(),
    };
    const row = open
      ? await this.prisma.notification.update({
          where: { id: open.id },
          data: fields,
        })
      : await this.prisma.notification.create({
          data: { ...fields, groupKey },
        });
    if (
      options.push === 'always' ||
      (options.push === 'milestones' && milestone !== undefined)
    ) {
      await this.queue.add(
        NotificationJobs.PUSH,
        { notificationId: row.id },
        {
          ...DELIVERY_RETRIES,
          jobId: pushJobId(row.id, row.updatedAt.getTime()),
        },
      );
    }
    await this.publisher.publish(row.id);
  }

  /** Writes the row and sends it live; [push] false keeps it to the app (dot, center). */
  private async immediate(
    data: {
      recipientId: string;
      type: NotificationType;
      actorId?: string;
      tripId?: string;
      markerId?: string;
      payload?: Prisma.InputJsonObject;
    },
    push = true,
  ): Promise<void> {
    const row = await this.prisma.notification.create({
      data: { ...data, payload: data.payload ?? {} },
    });
    if (push) {
      await this.queue.add(
        NotificationJobs.PUSH,
        { notificationId: row.id },
        { ...DELIVERY_RETRIES, jobId: pushJobId(row.id) },
      );
    }
    await this.publisher.publish(row.id);
  }
}

/** The start of a liked item's group keys (one per recipient). */
function likesKey(targetType: string, targetId: string): string {
  return `like:${targetType}:${targetId}`;
}
