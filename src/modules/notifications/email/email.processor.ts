import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { resolveLanguage } from '../notification-renderer';
import { EmailProvider } from './email.provider';
import { EMAIL_QUEUE, EmailJobs, type SendEmailJob } from './email.queue';
import { EmailRenderer } from './email-renderer';

@Processor(EMAIL_QUEUE)
export class EmailProcessor extends WorkerHost {
  private readonly logger = new Logger(EmailProcessor.name);

  constructor(
    private readonly renderer: EmailRenderer,
    private readonly provider: EmailProvider,
  ) {
    super();
  }

  async process(job: Job): Promise<unknown> {
    if (job.name !== EmailJobs.SEND) {
      throw new Error(`unknown email job ${job.name}`);
    }
    const { template, to, locale, params } = job.data as SendEmailJob;
    if (!this.provider.enabled) {
      // Never log the address; the template is enough to notice the gap.
      this.logger.warn(`Email ${template} skipped: RESEND_API_KEY is not set`);
      return { sent: false };
    }
    const email = this.renderer.render(
      template,
      resolveLanguage(locale),
      params,
    );
    await this.provider.send({
      to,
      ...email,
      idempotencyKey: `${template}/${job.id}`,
    });
    this.logger.log(`Email ${template} sent`);
    return { sent: true };
  }

  /** Failed jobs are removed (they hold an address), so leave a trace here. */
  @OnWorkerEvent('failed')
  onFailed(job: Job | undefined, error: Error): void {
    const template = (job?.data as SendEmailJob | undefined)?.template;
    this.logger.error(
      `Email ${template ?? 'unknown'} failed (attempt ${job?.attemptsMade ?? '?'}): ${error.message}`,
    );
  }
}
