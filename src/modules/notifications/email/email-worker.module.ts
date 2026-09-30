import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { EmailProvider } from './email.provider';
import { EMAIL_QUEUE } from './email.queue';
import { EmailProcessor } from './email.processor';
import { EmailRenderer } from './email-renderer';
import { EmailService } from './email.service';
import { ResendEmailProvider } from './resend.email-provider';

@Module({
  imports: [BullModule.registerQueue({ name: EMAIL_QUEUE })],
  providers: [
    EmailProcessor,
    EmailRenderer,
    EmailService,
    { provide: EmailProvider, useClass: ResendEmailProvider },
  ],
  exports: [EmailService],
})
export class EmailWorkerModule {}
