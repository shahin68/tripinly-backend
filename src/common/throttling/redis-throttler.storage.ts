import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ThrottlerStorage } from '@nestjs/throttler';
import type { Redis } from 'ioredis';

type ThrottlerStorageRecord = Awaited<
  ReturnType<ThrottlerStorage['increment']>
>;
import { REDIS } from '../redis/redis.module';

/**
 * Fixed-window counter with an optional block, in one round trip.
 * KEYS: hits key, block key. ARGV: ttl ms, limit, block ms.
 * Returns hits, ms until the window resets, blocked (0/1), ms until the block ends.
 */
const INCREMENT_SCRIPT = `
local hits = redis.call('INCR', KEYS[1])
if hits == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('PTTL', KEYS[1])
local blocked = redis.call('PTTL', KEYS[2])
if blocked > 0 then return {hits, ttl, 1, blocked} end
if hits > tonumber(ARGV[2]) then
  redis.call('SET', KEYS[2], '1', 'PX', ARGV[3])
  return {hits, ttl, 1, tonumber(ARGV[3])}
end
return {hits, ttl, 0, 0}
`;

/**
 * Shares rate-limit counters across API instances. Fails open: if Redis is
 * unavailable, requests are let through rather than rejected.
 */
@Injectable()
export class RedisThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger(RedisThrottlerStorage.name);

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const base = `throttle:${throttlerName}:${key}`;
    try {
      const [hits, ttlMs, blocked, blockMs] = (await this.redis.eval(
        INCREMENT_SCRIPT,
        2,
        `${base}:hits`,
        `${base}:block`,
        ttl,
        limit,
        blockDuration,
      )) as [number, number, number, number];
      return {
        totalHits: hits,
        timeToExpire: Math.ceil(Math.max(ttlMs, 0) / 1000),
        isBlocked: blocked === 1,
        timeToBlockExpire: Math.ceil(Math.max(blockMs, 0) / 1000),
      };
    } catch (error) {
      this.logger.warn(
        `Rate limit check skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
      return {
        totalHits: 0,
        timeToExpire: 0,
        isBlocked: false,
        timeToBlockExpire: 0,
      };
    }
  }
}
