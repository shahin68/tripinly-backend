import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  ACCOUNT_QUEUE,
  AccountJobs,
  AccountJobsService,
  deleteJobId,
} from './account.queue';
import { DataExportService } from './data-export.service';

const STUCK_AFTER_MS = 15 * 60 * 1000;
const EXPORT_GIVE_UP_MS = 6 * 60 * 60 * 1000;

/** Keeps deletions moving and exports tidy when a job was lost or ran out of retries. */
@Injectable()
export class AccountSweeper {
  private readonly logger = new Logger(AccountSweeper.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: AccountJobsService,
    private readonly exports: DataExportService,
    @InjectQueue(ACCOUNT_QUEUE) private readonly queue: Queue,
  ) {}

  async sweep(): Promise<Record<string, number>> {
    // Deletions never give up: a failed one is retried every hour.
    let retried = 0;
    for (const job of await this.queue.getFailed()) {
      if (job.name !== AccountJobs.DELETE) continue;
      await job.retry();
      retried++;
    }
    // Accounts marked deleting whose job never made it into the queue.
    let requeued = 0;
    const stuck = await this.prisma.user.findMany({
      where: {
        status: 'deleting',
        updatedAt: { lt: new Date(Date.now() - STUCK_AFTER_MS) },
      },
      select: { id: true },
      take: 500,
    });
    for (const { id } of stuck) {
      if (await this.queue.getJob(deleteJobId(id))) continue;
      await this.jobs.delete(id);
      requeued++;
    }

    const expired = await this.exports.expireOld();
    const { count: abandoned } = await this.prisma.dataExport.updateMany({
      where: {
        status: 'pending',
        createdAt: { lt: new Date(Date.now() - EXPORT_GIVE_UP_MS) },
      },
      data: { status: 'failed' },
    });

    const result = { retried, requeued, expired, abandoned };
    if (retried + requeued + abandoned > 0) {
      this.logger.warn(`Account sweep: ${JSON.stringify(result)}`);
    }
    return result;
  }

  async purgeConsentProofs(): Promise<number> {
    const { count } = await this.prisma.consentProof.deleteMany({
      where: { retainUntil: { lte: new Date() } },
    });
    if (count > 0) this.logger.log(`Purged ${count} expired consent proof(s)`);
    return count;
  }
}
