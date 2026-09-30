import { Inject, Injectable, Logger } from '@nestjs/common';
import { Emitter } from '@socket.io/redis-emitter';
import type { Redis } from 'ioredis';
import { PrismaService } from '../../common/prisma/prisma.service';
import { REDIS } from '../../common/redis/redis.module';
import {
  REALTIME_NAMESPACE,
  type RealtimeMessage,
  tripRoom,
  userRoom,
} from './realtime.rooms';

/**
 * Publishes realtime events through Redis, from the api and the worker alike;
 * the Socket.IO Redis adapter delivers them to sockets on every API instance.
 * Fire-and-forget: a failed publish is logged, and clients refetch on reconnect.
 */
@Injectable()
export class RealtimePublisher {
  private readonly logger = new Logger(RealtimePublisher.name);
  private readonly emitter: Emitter;

  constructor(
    @Inject(REDIS) redis: Redis,
    private readonly prisma: PrismaService,
  ) {
    // The emitter only ever calls publish; catch here so a Redis outage can't
    // surface as an unhandled rejection.
    const client = {
      publish: (channel: string, message: string | Buffer) =>
        redis.publish(channel, message).catch((error: unknown) => {
          this.logger.warn(
            `Realtime publish failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }),
    };
    this.emitter = new Emitter(client).of(REALTIME_NAMESPACE);
  }

  /** To the trip room, skipping everyone with a block either way with the actor. */
  async toTrip(message: RealtimeMessage & { tripId: string }): Promise<void> {
    const excluded = message.actorId
      ? (await this.blockedWith(message.actorId)).map(userRoom)
      : [];
    this.emitter
      .to(tripRoom(message.tripId))
      .except(excluded)
      .emit(message.event, message);
  }

  toUser(userId: string, message: RealtimeMessage): void {
    this.emitter.to(userRoom(userId)).emit(message.event, message);
  }

  /** Removes these users' sockets from the trip room (they lost view access). */
  evictFromTrip(tripId: string, userIds: string[]): void {
    if (userIds.length === 0) return;
    this.emitter.in(userIds.map(userRoom)).socketsLeave(tripRoom(tripId));
  }

  /** Removes everyone but these members from the trip room (it turned private). */
  keepOnlyMembers(tripId: string, memberIds: string[]): void {
    this.emitter
      .in(tripRoom(tripId))
      .except(memberIds.map(userRoom))
      .socketsLeave(tripRoom(tripId));
  }

  /** Removes a user's sockets from these trip rooms. */
  leaveTrips(userId: string, tripIds: string[]): void {
    if (tripIds.length === 0) return;
    this.emitter.in(userRoom(userId)).socketsLeave(tripIds.map(tripRoom));
  }

  clearTrip(tripId: string): void {
    this.emitter.in(tripRoom(tripId)).socketsLeave(tripRoom(tripId));
  }

  /** Closes every socket of a user (suspension, deletion). */
  disconnectUser(userId: string): void {
    this.emitter.in(userRoom(userId)).disconnectSockets(true);
  }

  private async blockedWith(userId: string): Promise<string[]> {
    const blocks = await this.prisma.block.findMany({
      where: { OR: [{ blockerId: userId }, { blockedId: userId }] },
      select: { blockerId: true, blockedId: true },
    });
    return blocks.map((block) =>
      block.blockerId === userId ? block.blockedId : block.blockerId,
    );
  }
}
