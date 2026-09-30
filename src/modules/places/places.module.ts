import { Module } from '@nestjs/common';
import { TripsModule } from '../trips/trips.module';
import { PhotonClient } from './photon.client';
import { PlaceMatchingService } from './place-matching.service';
import { PlacesController } from './places.controller';
import { PlacesService } from './places.service';

@Module({
  imports: [TripsModule],
  controllers: [PlacesController],
  providers: [PlaceMatchingService, PlacesService, PhotonClient],
  exports: [PlaceMatchingService, PlacesService],
})
export class PlacesModule {}
