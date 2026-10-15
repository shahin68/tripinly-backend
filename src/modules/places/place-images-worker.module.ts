import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { PLACE_IMAGES_QUEUE } from './place-images.queue';
import { PlaceImagesProcessor } from './place-images.processor';
import { PlaceImagesScheduler } from './place-images.scheduler';
import { PlaceImagesService } from './place-images.service';
import { WikimediaClient } from './wikimedia.client';

/** Worker side: copies Wikimedia Commons images of places into storage. */
@Module({
  imports: [BullModule.registerQueue({ name: PLACE_IMAGES_QUEUE })],
  providers: [
    PlaceImagesService,
    WikimediaClient,
    PlaceImagesProcessor,
    PlaceImagesScheduler,
  ],
  exports: [PlaceImagesService],
})
export class PlaceImagesWorkerModule {}
