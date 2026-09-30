import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { AppleIdentityVerifier } from '../auth/identity/apple-identity.verifier';
import { RevenueCatClient } from '../billing/revenuecat.client';
import { EmailModule } from '../notifications/email/email.module';
import { PhotoJobsModule } from '../photos/photo-jobs.module';
import { PhotosModule } from '../photos/photos.module';
import { SocialModule } from '../social/social.module';
import { TripsModule } from '../trips/trips.module';
import { AccountDeletionService } from './account-deletion.service';
import { AccountProcessor } from './account.processor';
import { ACCOUNT_QUEUE, AccountJobsService } from './account.queue';
import { AccountScheduler } from './account.scheduler';
import { AccountSweeper } from './account.sweeper';
import { DataExportService } from './data-export.service';

/**
 * Worker side: account deletion, data export and their housekeeping. Uses
 * the same services as the API to delete trips, photos and comments, so
 * covers, counters and realtime events stay right.
 */
@Module({
  imports: [
    BullModule.registerQueue({ name: ACCOUNT_QUEUE }),
    TripsModule,
    PhotosModule,
    SocialModule,
    PhotoJobsModule,
    EmailModule,
  ],
  providers: [
    AccountProcessor,
    AccountScheduler,
    AccountSweeper,
    AccountJobsService,
    AccountDeletionService,
    DataExportService,
    AppleIdentityVerifier,
    RevenueCatClient,
  ],
})
export class AccountWorkerModule {}
