import { Module } from '@nestjs/common';
import { ModerationModule } from '../moderation/moderation.module';
import { PlacesModule } from '../places/places.module';
import { TripsModule } from '../trips/trips.module';
import { MarkersController } from './markers.controller';
import { MarkersService } from './markers.service';

@Module({
  imports: [TripsModule, PlacesModule, ModerationModule],
  controllers: [MarkersController],
  providers: [MarkersService],
})
export class MarkersModule {}
