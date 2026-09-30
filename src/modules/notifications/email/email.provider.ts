export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Same key on a retry, so a retried job doesn't send twice. */
  idempotencyKey: string;
}

/** Sends transactional email; Resend in production (ResendEmailProvider). */
export abstract class EmailProvider {
  /** False when no API key is configured: emails are skipped with a warning. */
  abstract readonly enabled: boolean;
  abstract send(message: EmailMessage): Promise<void>;
}
