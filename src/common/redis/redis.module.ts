import {
  Global,
  Inject,
  Logger,
  Module,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import type { Env } from '../config/env';

export const REDIS = Symbol('REDIS');

/** Shared connection for caches and rate limits. BullMQ gets its own connections. */
@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        new Redis(config.get('REDIS_URL', { infer: true }), {
          lazyConnect: true,
          maxRetriesPerRequest: 2,
          enableOfflineQueue: false,
        }),
    },
  ],
  exports: [REDIS],
})
export class RedisModule implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(RedisModule.name);

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  /**
   * Connect once the app is up. With the offline queue off, commands sent while
   * disconnected fail fast instead of waiting, so callers must tolerate that;
   * ioredis keeps reconnecting in the background.
   */
  onApplicationBootstrap(): void {
    if (this.redis.status === 'wait') {
      this.redis.connect().catch((error: unknown) => {
        if (this.redis.status === 'end') return; // closed during shutdown
        this.logger.warn(
          `Redis not reachable yet: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.redis.status === 'ready') {
      await this.redis.quit().catch(() => this.redis.disconnect());
    } else if (this.redis.status !== 'end') {
      // Still connecting or reconnecting: QUIT can't be sent, so stop retrying.
      this.redis.disconnect();
    }
  }
}
