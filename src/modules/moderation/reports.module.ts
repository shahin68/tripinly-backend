import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MarkersModule } from '../markers/markers.module';
import { PhotosModule } from '../photos/photos.module';
import { SocialModule } from '../social/social.module';
import { TripsModule } from '../trips/trips.module';
import { AdminGuard } from './admin.guard';
import { ModerationService } from './moderation.service';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

/**
 * Reports and admin review. Separate from ModerationModule (blocks), which
 * the trip modules depend on, because this one depends on them.
 */
@Module({
  imports: [AuthModule, TripsModule, MarkersModule, PhotosModule, SocialModule],
  controllers: [ReportsController],
  providers: [ReportsService, ModerationService, AdminGuard],
})
export class ReportsModule {}
