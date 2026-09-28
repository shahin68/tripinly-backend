import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { configureApp } from '../bootstrap/configure-app';
import { buildOpenApiDocument } from '../bootstrap/openapi';

/**
 * Writes openapi.json at the repository root; the KMP client generates its API
 * layer from it. Needs env vars to boot, but never opens a DB or Redis connection.
 */
async function exportOpenApi(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: false });
  configureApp(app);
  await app.init();
  const document = buildOpenApiDocument(app);
  const target = join(__dirname, '..', '..', 'openapi.json');
  writeFileSync(target, `${JSON.stringify(document, null, 2)}\n`);
  await app.close();
  process.stdout.write(`OpenAPI written to ${target}\n`);
}

void exportOpenApi();
