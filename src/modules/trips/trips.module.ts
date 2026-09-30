import { Module } from '@nestjs/common';
import { ModerationModule } from '../moderation/moderation.module';
import { PhotoJobsModule } from '../photos/photo-jobs.module';
import { MembersService } from './members.service';
import { TripAccessService } from './trip-access.service';
import { TripsController } from './trips.controller';
import { TripsService } from './trips.service';

@Module({
  imports: [ModerationModule, PhotoJobsModule],
  controllers: [TripsController],
  providers: [TripsService, TripAccessService, MembersService],
  exports: [TripsService, TripAccessService, MembersService],
})
export class TripsModule {}
