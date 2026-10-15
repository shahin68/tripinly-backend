import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job, Queue } from 'bullmq';
import { PlaceImageJobs, PLACE_IMAGES_QUEUE } from './place-images.queue';
import { PlaceImagesService } from './place-images.service';

/**
 * One job at a time, so Wikimedia sees one request a second. A run does a
 * bounded amount of work and queues the next run while more is waiting.
 */
@Processor(PLACE_IMAGES_QUEUE, { concurrency: 1, lockDuration: 5 * 60_000 })
export class PlaceImagesProcessor extends WorkerHost {
  constructor(
    private readonly images: PlaceImagesService,
    @InjectQueue(PLACE_IMAGES_QUEUE) private readonly queue: Queue,
  ) {
    super();
  }

  async process(job: Job): Promise<unknown> {
    let result: { more: boolean };
    switch (job.name) {
      case PlaceImageJobs.SYNC:
        result = await this.images.sync();
        break;
      case PlaceImageJobs.REVALIDATE:
        result = await this.images.revalidate();
        break;
      default:
        throw new Error(`unknown place-images job ${job.name}`);
    }
    if (result.more) {
      await this.queue.add(job.name, {}, { removeOnComplete: true });
    }
    return result;
  }
}
