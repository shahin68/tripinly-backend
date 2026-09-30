import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';

export const PHOTOS_QUEUE = 'photos';

export const PhotoJobs = {
  /** Strip metadata, make thumb and display, mark ready. */
  PROCESS: 'process',
  /** Delete every file of the given photos (rows are already gone). */
  DELETE_FILES: 'delete-files',
  /** Hourly: drop uploads never completed and failed photos. */
  CLEANUP: 'cleanup',
} as const;

export interface ProcessJob {
  photoId: string;
}

export interface DeleteFilesJob {
  photoIds: string[];
}

const RETRY = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 5_000 },
} as const;
/** Keeps each delete job small. */
const DELETE_BATCH = 100;

/** Enqueues photo work for the worker. Call after the database transaction commits. */
@Injectable()
export class PhotoJobsService {
  private readonly logger = new Logger(PhotoJobsService.name);

  constructor(@InjectQueue(PHOTOS_QUEUE) private readonly queue: Queue) {}

  async process(photoId: string): Promise<void> {
    // One job per photo: completing twice doesn't process twice.
    await this.queue.add(PhotoJobs.PROCESS, { photoId } satisfies ProcessJob, {
      jobId: `process-${photoId}`,
      ...RETRY,
    });
  }

  /**
   * Deletes the files of photos whose rows were deleted. A failure to enqueue
   * is logged, not thrown: the delete already happened, and the hourly
   * cleanup can't find files without rows, so this is the one chance.
   */
  async deleteFiles(photoIds: string[]): Promise<void> {
    for (let i = 0; i < photoIds.length; i += DELETE_BATCH) {
      const batch = photoIds.slice(i, i + DELETE_BATCH);
      try {
        await this.queue.add(
          PhotoJobs.DELETE_FILES,
          { photoIds: batch } satisfies DeleteFilesJob,
          RETRY,
        );
      } catch (error) {
        this.logger.error(
          `Could not queue file deletion for ${batch.length} photos: ${(error as Error).message}; ids ${batch.join(',')}`,
        );
      }
    }
  }
}
