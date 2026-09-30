import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ConsentsModule } from '../consents/consents.module';
import { TripsModule } from '../trips/trips.module';
import { RealtimeGateway } from './realtime.gateway';
import { RealtimeListener } from './realtime.listener';
import { RealtimePublisher } from './realtime.publisher';

/** API side: the Socket.IO gateway plus the domain-event bridge. */
@Module({
  imports: [AuthModule, ConsentsModule, TripsModule],
  providers: [RealtimeGateway, RealtimePublisher, RealtimeListener],
  exports: [RealtimePublisher],
})
export class RealtimeModule {}
