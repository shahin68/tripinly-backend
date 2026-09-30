import { Module } from '@nestjs/common';
import { PhotoCleanupService } from './photo-cleanup.service';
import { PhotoProcessingService } from './photo-processing.service';

/** Processing and file cleanup, without a queue consumer (the worker module adds that). */
@Module({
  providers: [PhotoProcessingService, PhotoCleanupService],
  exports: [PhotoProcessingService, PhotoCleanupService],
})
export class PhotoProcessingModule {}
