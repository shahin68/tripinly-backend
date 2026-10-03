import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS } from '../redis/redis.module';

/** How long a finished request can be replayed with the same key. */
export const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;
/** How long a key stays locked while its first request runs (covers a crash mid-request). */
export const IDEMPOTENCY_LOCK_SECONDS = 60;

export type IdempotencyRecord =
  | { state: 'pending'; fingerprint: string }
  | { state: 'done'; fingerprint: string; body: unknown };

/**
 * Remembers the response to a content-creating POST per user and key, in Redis.
 * Holds what the user posted for a day, so account deletion purges it.
 */
@Injectable()
export class IdempotencyStore {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  /** Locks the key for this request; returns the existing record when there is one. */
  async begin(
    userId: string,
    key: string,
    fingerprint: string,
  ): Promise<IdempotencyRecord | null> {
    const redisKey = this.key(userId, key);
    const pending: IdempotencyRecord = { state: 'pending', fingerprint };
    const locked = await this.redis.set(
      redisKey,
      JSON.stringify(pending),
      'EX',
      IDEMPOTENCY_LOCK_SECONDS,
      'NX',
    );
    if (locked) return null;
    const existing = await this.redis.get(redisKey);
    // Expired between the two calls: treat as taken by a concurrent request.
    return existing ? (JSON.parse(existing) as IdempotencyRecord) : pending;
  }

  async complete(
    userId: string,
    key: string,
    fingerprint: string,
    body: unknown,
  ): Promise<void> {
    const record: IdempotencyRecord = {
      state: 'done',
      fingerprint,
      body: body ?? null,
    };
    await this.redis.set(
      this.key(userId, key),
      JSON.stringify(record),
      'EX',
      IDEMPOTENCY_TTL_SECONDS,
    );
  }

  /** Frees the key after a failed request so the client can retry it. */
  async release(userId: string, key: string): Promise<void> {
    await this.redis.del(this.key(userId, key));
  }

  async purgeUser(userId: string): Promise<void> {
    let cursor = '0';
    do {
      const [next, keys] = await this.redis.scan(
        cursor,
        'MATCH',
        `idempotency:${userId}:*`,
        'COUNT',
        500,
      );
      if (keys.length > 0) await this.redis.del(...keys);
      cursor = next;
    } while (cursor !== '0');
  }

  private key(userId: string, key: string): string {
    return `idempotency:${userId}:${key}`;
  }
}
