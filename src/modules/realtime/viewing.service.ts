import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS } from '../../common/redis/redis.module';

/** What a socket has open: a trip's map, or a stop's comments. */
export type View = `trip:${string}` | `comments:${string}`;

/**
 * Forgets a view nobody closed (an api instance that died) after an hour; a
 * push resumes then, which is harmless.
 */
const VIEW_TTL_SECONDS = 60 * 60;

/**
 * Which views a user has open on any device, kept in Redis by the gateway so
 * the worker can skip pushes about what the user is looking at
 * (05-realtime-and-notifications.md, Open views). Each view holds the ids of
 * the sockets that opened it; it's open while one is left.
 */
@Injectable()
export class ViewingService {
  private readonly logger = new Logger(ViewingService.name);

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async open(userId: string, view: View, socketId: string): Promise<void> {
    const key = viewKey(userId, view);
    await this.safely(() =>
      this.redis
        .multi()
        .sadd(key, socketId)
        .expire(key, VIEW_TTL_SECONDS)
        .exec(),
    );
  }

  async close(userId: string, view: View, socketId: string): Promise<void> {
    await this.safely(() => this.redis.srem(viewKey(userId, view), socketId));
  }

  /** False when Redis can't answer, so the push goes out. */
  async isOpen(userId: string, view: View): Promise<boolean> {
    return (
      ((await this.safely(() => this.redis.scard(viewKey(userId, view)))) ??
        0) > 0
    );
  }

  private async safely<T>(command: () => Promise<T>): Promise<T | undefined> {
    try {
      return await command();
    } catch (error) {
      this.logger.warn(
        `Open views not updated: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  }
}

const viewKey = (userId: string, view: View): string =>
  `viewing:${userId}:${view}`;
