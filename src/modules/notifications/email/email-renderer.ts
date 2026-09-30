import { Injectable } from '@nestjs/common';
import { I18nService } from 'nestjs-i18n';
import type { EmailParams, EmailTemplate } from './email.queue';

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

/** Localized transactional emails (i18n/<lang>/email.json) in one plain layout, always with a text part. */
@Injectable()
export class EmailRenderer {
  constructor(private readonly i18n: I18nService) {}

  render<T extends EmailTemplate>(
    template: T,
    lang: string,
    params: EmailParams[T],
  ): RenderedEmail {
    const t = (key: string) => this.i18n.t(`email.${key}`, { lang });
    const subject = t(`${template}.subject`);
    const heading = t(`${template}.heading`);
    const body = t(`${template}.body`);
    const closing = t(`${template}.ignore`);
    const footer = t('footer');
    const link =
      template === 'data_export_ready'
        ? {
            url: (params as EmailParams['data_export_ready']).downloadUrl,
            label: t(`${template}.button`),
          }
        : undefined;

    const text = [
      heading,
      '',
      body,
      ...(link ? ['', `${link.label}: ${link.url}`] : []),
      '',
      closing,
      '',
      '—',
      footer,
    ].join('\n');

    const button = link
      ? `<p style="margin:24px 0"><a href="${escapeHtml(link.url)}" style="background:#1f6feb;color:#ffffff;padding:12px 20px;border-radius:8px;text-decoration:none;display:inline-block">${escapeHtml(link.label)}</a></p>`
      : '';
    const html = `<!doctype html>
<html lang="${escapeHtml(lang)}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:24px;background:#f6f7f9;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1b1f24">
<div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px">
<p style="font-size:14px;font-weight:600;letter-spacing:.04em;color:#1f6feb;margin:0 0 16px">Tripinly</p>
<h1 style="font-size:22px;margin:0 0 16px">${escapeHtml(heading)}</h1>
<p style="font-size:16px;line-height:1.5;margin:0">${escapeHtml(body)}</p>
${button}
<p style="font-size:14px;line-height:1.5;color:#57606a;margin:16px 0 0">${escapeHtml(closing)}</p>
</div>
<p style="max-width:520px;margin:16px auto 0;font-size:12px;line-height:1.5;color:#8c959f">${escapeHtml(footer)}</p>
</body>
</html>
`;
    return { subject, html, text };
  }
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
