import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_PIPE } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { CoreModule } from './common/core.module';
import { AllExceptionsFilter } from './common/errors/all-exceptions.filter';
import { createValidationPipe } from './common/errors/validation';
import { AppThrottlerGuard } from './common/throttling/app-throttler.guard';
import { QueueModule } from './common/queue/queue.module';
import { ThrottlingModule } from './common/throttling/throttling.module';
import { AuthGuard } from './modules/auth/auth.guard';
import { AuthModule } from './modules/auth/auth.module';
import { ConsentsModule } from './modules/consents/consents.module';
import { HealthModule } from './modules/health/health.module';
import { InvitesModule } from './modules/invites/invites.module';
import { MarkersModule } from './modules/markers/markers.module';
import { ModerationModule } from './modules/moderation/moderation.module';
import { PhotosModule } from './modules/photos/photos.module';
import { DiscoveryModule } from './modules/discovery/discovery.module';
import { PlacesModule } from './modules/places/places.module';
import { SocialModule } from './modules/social/social.module';
import { TripsModule } from './modules/trips/trips.module';
import { UsersModule } from './modules/users/users.module';

@Module({
  imports: [
    CoreModule,
    EventEmitterModule.forRoot(),
    ThrottlingModule,
    QueueModule,
    HealthModule,
    AuthModule,
    ConsentsModule,
    UsersModule,
    ModerationModule,
    TripsModule,
    PlacesModule,
    MarkersModule,
    InvitesModule,
    PhotosModule,
    SocialModule,
    DiscoveryModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_PIPE, useFactory: createValidationPipe },
    // Order matters: authenticate first so rate limits can key on the user.
    { provide: APP_GUARD, useExisting: AuthGuard },
    { provide: APP_GUARD, useClass: AppThrottlerGuard },
  ],
})
export class AppModule {}
