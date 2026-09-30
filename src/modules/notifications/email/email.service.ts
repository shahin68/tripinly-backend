import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';
import {
  EMAIL_QUEUE,
  EmailJobs,
  type EmailParams,
  type EmailTemplate,
  type SendEmailJob,
} from './email.queue';

/**
 * Queues a transactional email; the worker renders and sends it. The address
 * lives only in the job, which is removed as soon as it finishes or fails.
 */
@Injectable()
export class EmailService {
  constructor(@InjectQueue(EMAIL_QUEUE) private readonly queue: Queue) {}

  async send<T extends EmailTemplate>(
    template: T,
    to: string,
    locale: string,
    params: EmailParams[T],
  ): Promise<void> {
    await this.queue.add(
      EmailJobs.SEND,
      { template, to, locale, params } satisfies SendEmailJob<T>,
      {
        attempts: 5,
        backoff: { type: 'exponential', delay: 30_000 },
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
  }
}
