import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { CoreModule } from './common/core.module';
import { AllExceptionsFilter } from './common/errors/all-exceptions.filter';
import { createValidationPipe } from './common/errors/validation';
import { IdempotencyInterceptor } from './common/idempotency/idempotency.interceptor';
import { AppThrottlerGuard } from './common/throttling/app-throttler.guard';
import { QueueModule } from './common/queue/queue.module';
import { ThrottlingModule } from './common/throttling/throttling.module';
import { AccountModule } from './modules/account/account.module';
import { AuthGuard } from './modules/auth/auth.guard';
import { AuthModule } from './modules/auth/auth.module';
import { BillingModule } from './modules/billing/billing.module';
import { ConsentsModule } from './modules/consents/consents.module';
import { HealthModule } from './modules/health/health.module';
import { InvitesModule } from './modules/invites/invites.module';
import { MarkersModule } from './modules/markers/markers.module';
import { ModerationModule } from './modules/moderation/moderation.module';
import { ReportsModule } from './modules/moderation/reports.module';
import { PhotosModule } from './modules/photos/photos.module';
import { DiscoveryModule } from './modules/discovery/discovery.module';
import { EmailModule } from './modules/notifications/email/email.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { PlacesModule } from './modules/places/places.module';
import { RealtimeModule } from './modules/realtime/realtime.module';
import { RoutingModule } from './modules/routing/routing.module';
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
    BillingModule,
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
    RoutingModule,
    RealtimeModule,
    NotificationsModule,
    EmailModule,
    AccountModule,
    ReportsModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_PIPE, useFactory: createValidationPipe },
    // Order matters: authenticate first so rate limits can key on the user.
    { provide: APP_GUARD, useExisting: AuthGuard },
    { provide: APP_GUARD, useClass: AppThrottlerGuard },
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
  ],
})
export class AppModule {}
