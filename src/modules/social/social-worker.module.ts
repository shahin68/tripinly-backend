import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { CountersService } from './counters.service';
import { SocialProcessor } from './social.processor';
import { SOCIAL_QUEUE } from './social.queue';
import { SocialScheduler } from './social.scheduler';

/** Worker side: the nightly counter rebuild. */
@Module({
  imports: [BullModule.registerQueue({ name: SOCIAL_QUEUE })],
  providers: [CountersService, SocialProcessor, SocialScheduler],
  exports: [CountersService],
})
export class SocialWorkerModule {}
