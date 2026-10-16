import { Module } from '@nestjs/common';
import { ModerationModule } from '../moderation/moderation.module';
import { PlacesModule } from '../places/places.module';
import { TripsModule } from '../trips/trips.module';
import { PhotoJobsModule } from './photo-jobs.module';
import { PhotosController } from './photos.controller';
import { PhotosService } from './photos.service';

@Module({
  imports: [TripsModule, ModerationModule, PhotoJobsModule, PlacesModule],
  controllers: [PhotosController],
  providers: [PhotosService],
  exports: [PhotosService],
})
export class PhotosModule {}
