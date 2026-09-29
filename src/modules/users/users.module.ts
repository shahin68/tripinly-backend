import { Module } from '@nestjs/common';
import { ConsentsModule } from '../consents/consents.module';
import { DevicesService } from './devices.service';
import { MeController } from './me.controller';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  imports: [ConsentsModule],
  controllers: [MeController, UsersController],
  providers: [UsersService, DevicesService],
  exports: [UsersService, DevicesService],
})
export class UsersModule {}
