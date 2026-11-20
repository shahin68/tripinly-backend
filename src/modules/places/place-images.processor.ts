import {
  InjectQueue,
  OnWorkerEvent,
  Processor,
  WorkerHost,
} from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { BrandLogosService } from './brand-logos.service';
import {
  PLACE_IMAGE_JOB_RETRIES,
  PlaceImageJobs,
  PLACE_IMAGES_QUEUE,
} from './place-images.queue';
import { PlaceImagesService } from './place-images.service';

/**
 * One job at a time, so Wikimedia sees one request a second. A run does a
 * bounded amount of work and queues the next run while more is waiting.
 */
/** One pending logo retry at a time. */
export const LOGO_RETRY_JOB_ID = 'place-images-logo-retry';
const LOGO_RETRY_DELAY_MS = 10 * 60_000;

@Processor(PLACE_IMAGES_QUEUE, { concurrency: 1, lockDuration: 5 * 60_000 })
export class PlaceImagesProcessor extends WorkerHost {
  private readonly logger = new Logger(PlaceImagesProcessor.name);

  constructor(
    private readonly images: PlaceImagesService,
    private readonly brandLogos: BrandLogosService,
    @InjectQueue(PLACE_IMAGES_QUEUE) private readonly queue: Queue,
  ) {
    super();
  }

  async process(job: Job): Promise<unknown> {
    let result: { more: boolean };
    switch (job.name) {
      case PlaceImageJobs.SYNC: {
        // Brand logos come with the daily image sync, at the same Wikimedia pace. They go
        // first: a few hundred brands at most, while new places can keep the photos busy for long.
        const logos = await this.brandLogos
          .sync()
          .catch(async (error: Error) => {
            // The photos still run, and the logos are tried again in 10 minutes.
            this.logger.warn(`Brand logos failed: ${error.message}`);
            await this.queue.add(
              job.name,
              {},
              {
                ...PLACE_IMAGE_JOB_RETRIES,
                jobId: LOGO_RETRY_JOB_ID,
                delay: LOGO_RETRY_DELAY_MS,
                removeOnComplete: true,
                removeOnFail: true,
              },
            );
            return { brands: 0, logos: 0, more: false };
          });
        const images = await this.images.sync();
        const synced = {
          ...images,
          brandLogos: logos,
          more: images.more || logos.more,
        };
        result = synced;
        break;
      }
      case PlaceImageJobs.REVALIDATE:
        result = await this.images.revalidate();
        break;
      default:
        throw new Error(`unknown place-images job ${job.name}`);
    }
    if (result.more) {
      await this.queue.add(
        job.name,
        {},
        {
          ...PLACE_IMAGE_JOB_RETRIES,
          removeOnComplete: true,
        },
      );
    }
    return result;
  }

  /** Without this a failed run (Wikimedia refusing, a timeout) left no trace in the logs (Shahin, 2026-11-20). */
  @OnWorkerEvent('failed')
  onFailed(job: Job | undefined, error: Error): void {
    if (!job) return;
    const retry =
      job.attemptsMade < (job.opts.attempts ?? 1) ? ', will retry' : '';
    this.logger.warn(
      `Place images job ${job.name} failed: ${error.message}${retry}`,
    );
  }
}
