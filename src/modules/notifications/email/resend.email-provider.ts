import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';
import type { Env } from '../../../common/config/env';
import { type EmailMessage, EmailProvider } from './email.provider';

@Injectable()
export class ResendEmailProvider extends EmailProvider {
  private readonly client?: Resend;
  private readonly from?: string;

  constructor(config: ConfigService<Env, true>) {
    super();
    const key = config.get('RESEND_API_KEY', { infer: true });
    if (key) {
      this.client = new Resend(key);
      this.from = config.get('EMAIL_FROM', { infer: true });
    }
  }

  get enabled(): boolean {
    return this.client !== undefined;
  }

  async send(message: EmailMessage): Promise<void> {
    if (!this.client || !this.from) return;
    const { error } = await this.client.emails.send(
      {
        from: this.from,
        to: message.to,
        subject: message.subject,
        html: message.html,
        text: message.text,
      },
      { idempotencyKey: message.idempotencyKey },
    );
    // Resend returns errors instead of throwing; throw so BullMQ retries.
    // The message names the problem, never the address.
    if (error) throw new Error(`Resend: ${error.name}: ${error.message}`);
  }
}
