import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import type { Env } from '../../common/config/env';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  OSM_IMPORT_QUEUE,
  type OsmImportJob,
  regionJobKey,
} from './osm-import.queue';

/** Downloads fail now and then; retry after 10, 20 and 40 minutes. */
const RETRIES = {
  attempts: 4,
  backoff: { type: 'exponential', delay: 10 * 60_000 },
} as const;

/**
 * Keeps one monthly schedule per configured region (and none for regions that
 * were removed), and queues the initial load for regions never imported.
 * Does nothing unless OSM_IMPORT_ENABLED is set.
 */
@Injectable()
export class OsmImportScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(OsmImportScheduler.name);

  constructor(
    @InjectQueue(OSM_IMPORT_QUEUE) private readonly queue: Queue<OsmImportJob>,
    private readonly config: ConfigService<Env, true>,
    private readonly prisma: PrismaService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const enabled = this.config.get('OSM_IMPORT_ENABLED', { infer: true });
    const regions = enabled
      ? this.config.get('OSM_IMPORT_REGIONS', { infer: true })
      : [];
    const wanted = new Set(regions.map((r) => regionJobKey('monthly', r)));

    for (const scheduler of await this.queue.getJobSchedulers()) {
      if (scheduler.key && !wanted.has(scheduler.key)) {
        await this.queue.removeJobScheduler(scheduler.key);
      }
    }
    if (!enabled) return;

    const pattern = this.config.get('OSM_IMPORT_CRON', { infer: true });
    for (const region of regions) {
      await this.queue.upsertJobScheduler(
        regionJobKey('monthly', region),
        { pattern, tz: 'UTC' },
        { name: 'import', data: { region }, opts: RETRIES },
      );
      const imported = await this.prisma.osmImportRun.count({
        where: { region, status: { in: ['succeeded', 'degraded'] } },
      });
      if (!imported) {
        // The job id dedupes restarts while the initial load is queued or
        // running. A load that failed for good, or waits to retry, starts over
        // now: a restart is how a failing import gets tried again.
        const jobId = regionJobKey('initial', region);
        const previous = await this.queue.getJob(jobId);
        if (
          previous &&
          ((await previous.isFailed()) || (await previous.isDelayed()))
        ) {
          await previous.remove();
        }
        await this.queue.add('import', { region }, { jobId, ...RETRIES });
        this.logger.log(`Initial OSM import of ${region} is queued`);
      }
    }
  }
}
