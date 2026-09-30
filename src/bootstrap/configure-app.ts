import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import type { Env } from '../common/config/env';
import { RedisIoAdapter } from '../modules/realtime/redis-io.adapter';

export const API_PREFIX = 'v1';
export const JSON_BODY_LIMIT = '1mb';

/**
 * HTTP setup shared by main.ts, the OpenAPI export and integration tests, so
 * tests exercise exactly what production runs. Global pipe and filter are
 * registered in AppModule.
 */
export function configureApp(app: INestApplication): void {
  const express = app as NestExpressApplication;
  express.useLogger(express.get(Logger));
  // Railway terminates TLS at one proxy hop; needed for correct client IPs in rate limits.
  express.set('trust proxy', 1);
  express.disable('x-powered-by');
  express.useBodyParser('json', { limit: JSON_BODY_LIMIT });
  express.use(helmet());
  express.setGlobalPrefix(API_PREFIX, {
    exclude: [
      '.well-known/assetlinks.json',
      '.well-known/apple-app-site-association',
    ],
  });
  const config = express.get<ConfigService<Env, true>>(ConfigService);
  express.useWebSocketAdapter(
    new RedisIoAdapter(express, config.get('REDIS_URL', { infer: true })),
  );
  express.enableShutdownHooks();
}
