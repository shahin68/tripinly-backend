import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { SOCIAL_QUEUE, SocialJobs } from './social.queue';

@Injectable()
export class SocialScheduler implements OnApplicationBootstrap {
  constructor(@InjectQueue(SOCIAL_QUEUE) private readonly queue: Queue) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertJobScheduler(
      'social-recount',
      { pattern: '40 3 * * *', tz: 'UTC' },
      { name: SocialJobs.RECOUNT },
    );
  }
}
