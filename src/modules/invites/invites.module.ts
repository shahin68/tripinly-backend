import { Module } from '@nestjs/common';
import { ModerationModule } from '../moderation/moderation.module';
import { TripsModule } from '../trips/trips.module';
import { InvitesController } from './invites.controller';
import { InvitesService } from './invites.service';

@Module({
  imports: [TripsModule, ModerationModule],
  controllers: [InvitesController],
  providers: [InvitesService],
})
export class InvitesModule {}
