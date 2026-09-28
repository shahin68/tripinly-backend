import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { WorkerModule } from './worker.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    bufferLogs: true,
  });
  const logger = app.get(Logger);
  app.useLogger(logger);
  // SIGTERM closes the context; BullMQ workers finish their active jobs in onModuleDestroy.
  app.enableShutdownHooks();
  await app.init();
  logger.log('Worker started', 'Worker');
}

void bootstrap();
