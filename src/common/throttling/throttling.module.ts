import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import type { Redis } from 'ioredis';
import { REDIS } from '../redis/redis.module';
import { RedisThrottlerStorage } from './redis-throttler.storage';

const MINUTE_MS = 60_000;

/** Every route: per user (or per IP when signed out). */
export const DEFAULT_RATE_LIMIT = { limit: 120, ttl: MINUTE_MS };
/** Sign-in, refresh and logout: per IP. */
export const AUTH_RATE_LIMIT = { limit: 20, ttl: MINUTE_MS };
/** Photo upload URLs, per user. */
export const UPLOAD_RATE_LIMIT = { limit: 60, ttl: MINUTE_MS };
/** Place search, per user: it also calls Photon, whose public instance asks for fair use. */
export const SEARCH_RATE_LIMIT = { limit: 60, ttl: MINUTE_MS };

@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      useFactory: (redis: Redis) => ({
        throttlers: [{ name: 'default', ...DEFAULT_RATE_LIMIT }],
        storage: new RedisThrottlerStorage(redis),
      }),
      inject: [REDIS],
    }),
  ],
})
export class ThrottlingModule {}
