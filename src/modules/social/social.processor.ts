import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { CountersService } from './counters.service';
import { SOCIAL_QUEUE, SocialJobs } from './social.queue';

@Processor(SOCIAL_QUEUE)
export class SocialProcessor extends WorkerHost {
  constructor(private readonly counters: CountersService) {
    super();
  }

  async process(job: Job): Promise<unknown> {
    switch (job.name) {
      case SocialJobs.RECOUNT:
        return this.counters.recountAll();
      default:
        throw new Error(`unknown social job ${job.name}`);
    }
  }
}
