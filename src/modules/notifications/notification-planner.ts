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
  type CommentPayload,
  excerpt,
  type LikesPayload,
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
 * the in-app row and sends its push at once, for every type (Shahin,
 * 2026-11-01). The same thing again from the same person (a like, unlike and
 * like; the same stop moved twice) within NOTIFICATION_REPEAT_COOLDOWN_SECONDS
 * is dropped.
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
        await this.prisma.notification.deleteMany({
          where: {
            type: 'comment_on_marker',
            payload: { path: ['commentId'], equals: input.commentId },
          },
        });
        return;
      case 'added_to_trip':
        return this.addedToTrip(input);
      case 'join_requested':
        return this.joinRequested(input);
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
    for (const recipientId of recipients) {
      if (
        !(await this.isFirstInCooldown(
          `${recipientId}:${input.actorId}:${input.change}:${input.subjectId ?? input.tripId}`,
        ))
      ) {
        continue;
      }
      await this.immediate({
        recipientId,
        type: 'trip_changed_by_collaborator',
        actorId: input.actorId,
        tripId: input.tripId,
        payload: payload as unknown as Prisma.InputJsonObject,
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
    if (
      !(await this.isFirstInCooldown(
        `${recipientId}:${input.actorId}:like:${input.targetType}:${input.targetId}`,
      ))
    ) {
      return;
    }
    const payload: LikesPayload = {
      likerIds: [input.actorId],
      tripIds: [input.tripId],
    };
    await this.immediate({
      recipientId,
      type: 'likes_grouped',
      actorId: input.actorId,
      tripId: input.tripId,
      payload: payload as unknown as Prisma.InputJsonObject,
    });
  }

  /**
   * True for the first of identical notifications within the cooldown, so a
   * like, unlike and like again pushes once. If Redis can't answer, it sends.
   */
  private async isFirstInCooldown(key: string): Promise<boolean> {
    const seconds = this.config.get('NOTIFICATION_REPEAT_COOLDOWN_SECONDS', {
      infer: true,
    });
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
}
