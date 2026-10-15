import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import type { Env } from '../../common/config/env';
import { StorageService } from '../../common/storage/storage.service';
import { PlaceImageJobs, PLACE_IMAGES_QUEUE } from './place-images.queue';

const SCHEDULES = [
  {
    key: 'place-images-sync',
    pattern: '30 4 * * *',
    name: PlaceImageJobs.SYNC,
  },
  {
    key: 'place-images-revalidate',
    pattern: '0 5 * * 0',
    name: PlaceImageJobs.REVALIDATE,
  },
] as const;

/** Dedupes restarts while a startup sync is queued or running. */
export const STARTUP_SYNC_JOB_ID = 'place-images-startup';

/**
 * Daily sync (it picks up each OSM import's tag changes) and weekly recheck,
 * only while PLACE_IMAGES_SYNC_ENABLED is set and storage is configured. Each
 * start also queues one sync, so new places and a first switch-on don't wait
 * for the schedule; with nothing changed it does one query.
 */
@Injectable()
export class PlaceImagesScheduler implements OnApplicationBootstrap {
  constructor(
    @InjectQueue(PLACE_IMAGES_QUEUE) private readonly queue: Queue,
    private readonly config: ConfigService<Env, true>,
    private readonly storage: StorageService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const enabled =
      this.config.get('PLACE_IMAGES_SYNC_ENABLED', { infer: true }) &&
      this.storage.enabled;
    for (const schedule of SCHEDULES) {
      if (!enabled) {
        await this.queue.removeJobScheduler(schedule.key);
        continue;
      }
      await this.queue.upsertJobScheduler(
        schedule.key,
        { pattern: schedule.pattern, tz: 'UTC' },
        { name: schedule.name },
      );
    }
    if (enabled) {
      await this.queue.add(
        PlaceImageJobs.SYNC,
        {},
        {
          jobId: STARTUP_SYNC_JOB_ID,
          removeOnComplete: true,
          removeOnFail: true,
        },
      );
    }
  }
}
