import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env';

/**
 * BullMQ root configuration, with its own Redis connections (workers block, so
 * they can't share the cache connection). Feature modules register their
 * queues with BullModule.registerQueue.
 */
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        connection: {
          url: config.get('REDIS_URL', { infer: true }),
          // Railway's private network is IPv6-only.
          family: 0,
          maxRetriesPerRequest: null,
        },
        prefix: 'tripinly',
        defaultJobOptions: {
          removeOnComplete: { count: 100 },
          removeOnFail: { count: 500 },
        },
      }),
    }),
  ],
})
export class QueueModule {}
