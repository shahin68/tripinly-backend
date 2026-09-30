import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { AccountDeletionService } from './account-deletion.service';
import {
  ACCOUNT_QUEUE,
  AccountJobs,
  type DeleteAccountJob,
  type ExportJob,
} from './account.queue';
import { AccountSweeper } from './account.sweeper';
import { DataExportService } from './data-export.service';

/** One deletion or export at a time per worker: they are heavy and rare. */
@Processor(ACCOUNT_QUEUE, { concurrency: 1 })
export class AccountProcessor extends WorkerHost {
  private readonly logger = new Logger(AccountProcessor.name);

  constructor(
    private readonly deletion: AccountDeletionService,
    private readonly exports: DataExportService,
    private readonly sweeper: AccountSweeper,
  ) {
    super();
  }

  async process(job: Job): Promise<unknown> {
    switch (job.name) {
      case AccountJobs.DELETE:
        return this.deletion.run(job as Job<DeleteAccountJob>);
      case AccountJobs.EXPORT:
        return this.exports.build((job.data as ExportJob).exportId);
      case AccountJobs.SWEEP:
        return this.sweeper.sweep();
      case AccountJobs.PURGE_CONSENT_PROOFS:
        return this.sweeper.purgeConsentProofs();
      default:
        throw new Error(`unknown account job ${job.name}`);
    }
  }

  /** An export out of retries is marked failed so the user can ask again. */
  @OnWorkerEvent('failed')
  async onFailed(job: Job | undefined, error: Error): Promise<void> {
    if (!job) return;
    this.logger.warn(`Account job ${job.name} failed: ${error.message}`);
    if (
      job.name === AccountJobs.EXPORT &&
      job.attemptsMade >= (job.opts.attempts ?? 1)
    ) {
      await this.exports.markFailed((job.data as ExportJob).exportId);
    }
  }
}
