import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { PhotoProcessingModule } from './photo-processing.module';
import { PHOTOS_QUEUE } from './photos.queue';
import { PhotosProcessor } from './photos.processor';
import { PhotosScheduler } from './photos.scheduler';

/** Worker side: consumes the photos queue and schedules the hourly cleanup. */
@Module({
  imports: [
    PhotoProcessingModule,
    BullModule.registerQueue({ name: PHOTOS_QUEUE }),
  ],
  providers: [PhotosProcessor, PhotosScheduler],
})
export class PhotosWorkerModule {}
