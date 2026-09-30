import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AccountController } from './account.controller';
import { ACCOUNT_QUEUE, AccountJobsService } from './account.queue';
import { AccountService } from './account.service';

/** API side of account deletion and data export; the work runs in the worker. */
@Module({
  imports: [AuthModule, BullModule.registerQueue({ name: ACCOUNT_QUEUE })],
  controllers: [AccountController],
  providers: [AccountService, AccountJobsService],
})
export class AccountModule {}
