import { Module } from '@nestjs/common';
import { MarkersModule } from '../markers/markers.module';
import { PlacesModule } from '../places/places.module';
import { TripsModule } from '../trips/trips.module';
import { OrsProvider } from './ors.provider';
import { RoutingController } from './routing.controller';
import { RoutingProvider } from './routing.provider';
import { RoutingService } from './routing.service';

@Module({
  imports: [TripsModule, PlacesModule, MarkersModule],
  controllers: [RoutingController],
  providers: [
    RoutingService,
    { provide: RoutingProvider, useClass: OrsProvider },
  ],
})
export class RoutingModule {}
