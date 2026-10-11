import { Module } from '@nestjs/common';
import { ConsentsModule } from '../consents/consents.module';
import { ModerationModule } from '../moderation/moderation.module';
import { DevicesService } from './devices.service';
import { FollowsController } from './follows.controller';
import { FollowsService } from './follows.service';
import { MeController } from './me.controller';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  imports: [ConsentsModule, ModerationModule],
  controllers: [MeController, UsersController, FollowsController],
  providers: [UsersService, DevicesService, FollowsService],
  exports: [UsersService, DevicesService, FollowsService],
})
export class UsersModule {}
