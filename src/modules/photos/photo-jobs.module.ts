import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { PHOTOS_QUEUE, PhotoJobsService } from './photos.queue';

/** The photos queue producer, for any module that creates or deletes photos. */
@Module({
  imports: [BullModule.registerQueue({ name: PHOTOS_QUEUE })],
  providers: [PhotoJobsService],
  exports: [PhotoJobsService],
})
export class PhotoJobsModule {}
