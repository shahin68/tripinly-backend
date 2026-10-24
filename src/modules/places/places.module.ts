import { Module } from '@nestjs/common';
import { TripsModule } from '../trips/trips.module';
import { PlaceCoversModule } from './place-covers.module';
import { PhotonClient } from './photon.client';
import { PlaceMatchingService } from './place-matching.service';
import { PlacesController } from './places.controller';
import { PlacesService } from './places.service';

@Module({
  imports: [TripsModule, PlaceCoversModule],
  controllers: [PlacesController],
  providers: [PlaceMatchingService, PlacesService, PhotonClient],
  exports: [PlaceMatchingService, PlacesService, PlaceCoversModule],
})
export class PlacesModule {}
