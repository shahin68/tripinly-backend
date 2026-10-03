import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from './config/env';
import { i18nModule } from './i18n/i18n.config';
import { IdempotencyModule } from './idempotency/idempotency.module';
import { loggerModule } from './logging/logger.module';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { StorageModule } from './storage/storage.module';

/** Infrastructure shared by the api and worker processes. */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnv,
    }),
    loggerModule,
    i18nModule,
    PrismaModule,
    RedisModule,
    IdempotencyModule,
    StorageModule,
  ],
})
export class CoreModule {}
