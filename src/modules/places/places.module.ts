import { Module } from '@nestjs/common';
import { PlaceMatchingService } from './place-matching.service';

@Module({
  providers: [PlaceMatchingService],
  exports: [PlaceMatchingService],
})
export class PlacesModule {}
