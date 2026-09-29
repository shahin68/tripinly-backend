import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ConfigService } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import type { Env } from '../config/env';

export const REQUEST_ID_HEADER = 'x-request-id';
const REQUEST_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

/**
 * Paths pino must never print. Tokens, emails, birth dates, coordinates, signed
 * URLs and comment bodies stay out of logs (docs/knowledge/07-security-and-gdpr.md).
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.accessToken',
  '*.refreshToken',
  '*.idToken',
  '*.identityToken',
  '*.authorizationCode',
  '*.email',
  '*.birthDate',
  '*.password',
];

/** Drops the query string: Nearby, search and in-view queries carry the user's location. */
export function stripQuery(url: string | undefined): string {
  if (!url) return '';
  const index = url.indexOf('?');
  return index === -1 ? url : url.slice(0, index);
}

export function resolveRequestId(req: IncomingMessage): string {
  const incoming = req.headers[REQUEST_ID_HEADER];
  return typeof incoming === 'string' && REQUEST_ID_PATTERN.test(incoming)
    ? incoming
    : randomUUID();
}

export const loggerModule = LoggerModule.forRootAsync({
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>) => {
    const isDevelopment =
      config.get('NODE_ENV', { infer: true }) === 'development';
    return {
      pinoHttp: {
        level: config.get('LOG_LEVEL', { infer: true }),
        redact: { paths: REDACT_PATHS, censor: '[redacted]' },
        genReqId: (req: IncomingMessage, res: ServerResponse) => {
          const id = resolveRequestId(req);
          res.setHeader(REQUEST_ID_HEADER, id);
          return id;
        },
        serializers: {
          req: (req: { id: string; method: string; url?: string }) => ({
            id: req.id,
            method: req.method,
            url: stripQuery(req.url),
          }),
          res: (res: { statusCode: number }) => ({
            statusCode: res.statusCode,
          }),
        },
        autoLogging: {
          ignore: (req: IncomingMessage) =>
            stripQuery(req.url).startsWith('/v1/health'),
        },
        transport: isDevelopment
          ? { target: 'pino-pretty', options: { singleLine: true } }
          : undefined,
      },
    };
  },
});
