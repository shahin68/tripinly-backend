import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module';
import { TripsModule } from '../trips/trips.module';
import { PlaceCoversModule } from './place-covers.module';
import { BrandPolicy } from './brands';
import { BrandsController } from './brands.controller';
import { BrandsService } from './brands.service';
import { PhotonClient } from './photon.client';
import { PlaceMatchingService } from './place-matching.service';
import { PlacesController } from './places.controller';
import { PlacesService } from './places.service';

@Module({
  // Billing is global in the API, but the worker also loads this module.
  imports: [TripsModule, PlaceCoversModule, BillingModule],
  controllers: [PlacesController, BrandsController],
  providers: [
    PlaceMatchingService,
    PlacesService,
    PhotonClient,
    BrandPolicy,
    BrandsService,
  ],
  exports: [
    PlaceMatchingService,
    PlacesService,
    PlaceCoversModule,
    BrandPolicy,
    BrandsService,
  ],
})
export class PlacesModule {}
