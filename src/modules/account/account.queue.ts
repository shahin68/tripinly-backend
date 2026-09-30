import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';

export const ACCOUNT_QUEUE = 'account';

export const AccountJobs = {
  /** Deletes an account (account-deletion skill); resumable, see DeleteAccountJob. */
  DELETE: 'delete',
  /** Builds a GDPR export ZIP. */
  EXPORT: 'export',
  /** Hourly: resumes stuck deletions and expires old exports. */
  SWEEP: 'sweep',
  /** Daily: drops consent proofs past their retention. */
  PURGE_CONSENT_PROOFS: 'purge-consent-proofs',
} as const;

/**
 * Progress lives in the job data, so a retry skips finished steps. The email
 * is read from the user's identities at the start and dropped once the
 * confirmation has been sent.
 */
export interface DeleteAccountJob {
  userId: string;
  email?: string | null;
  locale?: string;
  /** Every photo to delete from storage, collected before any row goes. */
  photoIds?: string[];
  appleRevoked?: boolean;
  revenueCatDeleted?: boolean;
  userDeleted?: boolean;
  filesQueued?: boolean;
  emailed?: boolean;
}

export interface ExportJob {
  exportId: string;
}

export const deleteJobId = (userId: string) => `delete-${userId}`;
export const exportJobId = (exportId: string) => `export-${exportId}`;

const DELETE_RETRY = {
  attempts: 10,
  backoff: { type: 'exponential', delay: 30_000 },
} as const;
const EXPORT_RETRY = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 60_000 },
} as const;
const WEEK_SECONDS = 7 * 24 * 60 * 60;

/** Enqueues account work for the worker. */
@Injectable()
export class AccountJobsService {
  constructor(@InjectQueue(ACCOUNT_QUEUE) private readonly queue: Queue) {}

  /** One job per user: asking twice doesn't delete twice. */
  async delete(userId: string): Promise<void> {
    await this.queue.add(
      AccountJobs.DELETE,
      { userId } satisfies DeleteAccountJob,
      {
        ...DELETE_RETRY,
        jobId: deleteJobId(userId),
        // The job data holds an email address until the job ends.
        removeOnComplete: true,
        removeOnFail: { age: WEEK_SECONDS },
      },
    );
  }

  async export(exportId: string): Promise<void> {
    await this.queue.add(AccountJobs.EXPORT, { exportId } satisfies ExportJob, {
      ...EXPORT_RETRY,
      jobId: exportJobId(exportId),
      removeOnComplete: true,
      removeOnFail: { age: WEEK_SECONDS },
    });
  }
}
