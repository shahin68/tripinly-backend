import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { EMAIL_QUEUE } from './email.queue';
import { EmailService } from './email.service';

/** Queues transactional email (data export ready, account deletion confirmed). */
@Module({
  imports: [BullModule.registerQueue({ name: EMAIL_QUEUE })],
  providers: [EmailService],
  exports: [EmailService],
})
export class EmailModule {}
