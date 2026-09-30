import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { StorageService } from '../../common/storage/storage.service';
import { PhotoJobs, PHOTOS_QUEUE } from './photos.queue';

@Injectable()
export class PhotosScheduler implements OnApplicationBootstrap {
  constructor(
    @InjectQueue(PHOTOS_QUEUE) private readonly queue: Queue,
    private readonly storage: StorageService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.storage.enabled) {
      await this.queue.removeJobScheduler('photos-cleanup');
      return;
    }
    await this.queue.upsertJobScheduler(
      'photos-cleanup',
      { pattern: '17 * * * *', tz: 'UTC' },
      { name: PhotoJobs.CLEANUP },
    );
  }
}
