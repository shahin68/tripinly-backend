import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_PIPE } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { CoreModule } from './common/core.module';
import { AllExceptionsFilter } from './common/errors/all-exceptions.filter';
import { createValidationPipe } from './common/errors/validation';
import { AppThrottlerGuard } from './common/throttling/app-throttler.guard';
import { ThrottlingModule } from './common/throttling/throttling.module';
import { AuthGuard } from './modules/auth/auth.guard';
import { AuthModule } from './modules/auth/auth.module';
import { ConsentsModule } from './modules/consents/consents.module';
import { HealthModule } from './modules/health/health.module';
import { InvitesModule } from './modules/invites/invites.module';
import { MarkersModule } from './modules/markers/markers.module';
import { ModerationModule } from './modules/moderation/moderation.module';
import { PlacesModule } from './modules/places/places.module';
import { TripsModule } from './modules/trips/trips.module';
import { UsersModule } from './modules/users/users.module';

@Module({
  imports: [
    CoreModule,
    EventEmitterModule.forRoot(),
    ThrottlingModule,
    HealthModule,
    AuthModule,
    ConsentsModule,
    UsersModule,
    ModerationModule,
    TripsModule,
    PlacesModule,
    MarkersModule,
    InvitesModule,
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
