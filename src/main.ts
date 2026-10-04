import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp } from './bootstrap/configure-app';
import { setupOpenApi } from './bootstrap/openapi';
import type { Env } from './common/config/env';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  configureApp(app);
  const config = app.get<ConfigService<Env, true>>(ConfigService);
  setupOpenApi(app, config.get('DEPLOY_ENV', { infer: true }) !== 'production');
  await app.listen(config.get('PORT', { infer: true }), '0.0.0.0');
}

void bootstrap();
