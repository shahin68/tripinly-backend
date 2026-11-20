import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { BrandLogosService } from './brand-logos.service';
import { PLACE_IMAGES_QUEUE } from './place-images.queue';
import { PlaceImagesProcessor } from './place-images.processor';
import { PlaceImagesScheduler } from './place-images.scheduler';
import { PlaceImagesService } from './place-images.service';
import { WikimediaClient } from './wikimedia.client';

/** Worker side: copies Wikimedia Commons images of places into storage, and brand logos onto brands. */
@Module({
  imports: [BullModule.registerQueue({ name: PLACE_IMAGES_QUEUE })],
  providers: [
    PlaceImagesService,
    BrandLogosService,
    WikimediaClient,
    PlaceImagesProcessor,
    PlaceImagesScheduler,
  ],
  exports: [PlaceImagesService],
})
export class PlaceImagesWorkerModule {}
