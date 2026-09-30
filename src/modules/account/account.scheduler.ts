import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { ACCOUNT_QUEUE, AccountJobs } from './account.queue';

@Injectable()
export class AccountScheduler implements OnApplicationBootstrap {
  constructor(@InjectQueue(ACCOUNT_QUEUE) private readonly queue: Queue) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertJobScheduler(
      'account-sweep',
      { pattern: '17 * * * *', tz: 'UTC' },
      { name: AccountJobs.SWEEP },
    );
    await this.queue.upsertJobScheduler(
      'account-purge-consent-proofs',
      { pattern: '10 4 * * *', tz: 'UTC' },
      { name: AccountJobs.PURGE_CONSENT_PROOFS },
    );
  }
}
