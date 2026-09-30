export const EMAIL_QUEUE = 'email';

export const EmailJobs = { SEND: 'send' } as const;

export const EMAIL_TEMPLATES = [
  'data_export_ready',
  'account_deletion_confirmed',
] as const;
export type EmailTemplate = (typeof EMAIL_TEMPLATES)[number];

export interface EmailParams {
  data_export_ready: { downloadUrl: string };
  account_deletion_confirmed: Record<string, never>;
}

export interface SendEmailJob<T extends EmailTemplate = EmailTemplate> {
  template: T;
  to: string;
  locale: string;
  params: EmailParams[T];
}
