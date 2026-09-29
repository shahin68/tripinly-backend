import type { INestApplication, ModuleMetadata } from '@nestjs/common';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap/configure-app';
import { setupOpenApi } from '../../src/bootstrap/openapi';

export interface TestAppOptions {
  imports?: ModuleMetadata['imports'];
  override?: (builder: TestingModuleBuilder) => TestingModuleBuilder;
}

/** Boots the real AppModule with the same HTTP setup as production. */
export async function createTestApp(
  options: TestAppOptions = {},
): Promise<INestApplication> {
  let builder = Test.createTestingModule({
    imports: [AppModule, ...(options.imports ?? [])],
  });
  if (options.override) {
    builder = options.override(builder);
  }
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication({ bufferLogs: true });
  configureApp(app);
  setupOpenApi(app, false);
  await app.init();
  return app;
}
