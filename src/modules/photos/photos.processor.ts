import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { PhotoCleanupService } from './photo-cleanup.service';
import { PhotoProcessingService } from './photo-processing.service';
import {
  type DeleteFilesJob,
  PhotoJobs,
  PHOTOS_QUEUE,
  type ProcessJob,
} from './photos.queue';

@Processor(PHOTOS_QUEUE, { concurrency: 4 })
export class PhotosProcessor extends WorkerHost {
  constructor(
    private readonly processing: PhotoProcessingService,
    private readonly cleanup: PhotoCleanupService,
  ) {
    super();
  }

  async process(job: Job): Promise<unknown> {
    switch (job.name) {
      case PhotoJobs.PROCESS:
        return this.processing.process((job.data as ProcessJob).photoId);
      case PhotoJobs.DELETE_FILES:
        return this.cleanup.deleteFiles((job.data as DeleteFilesJob).photoIds);
      case PhotoJobs.CLEANUP:
        return this.cleanup.removeStale();
      default:
        throw new Error(`unknown photos job ${job.name}`);
    }
  }

  /** A processing job that won't be retried again leaves the photo failed. */
  @OnWorkerEvent('failed')
  async onFailed(job: Job | undefined, error: Error): Promise<void> {
    if (!job || job.name !== PhotoJobs.PROCESS) return;
    const final =
      error.name === 'UnrecoverableError' ||
      job.attemptsMade >= (job.opts.attempts ?? 1);
    if (final) {
      await this.processing.markFailed(
        (job.data as ProcessJob).photoId,
        error.message,
      );
    }
  }
}
