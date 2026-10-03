import { join } from 'node:path';
import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { HealthService, MIGRATIONS_DIR } from './health.service';

@Module({
  controllers: [HealthController],
  providers: [
    HealthService,
    // The image runs from /app with prisma/ copied next to dist/ (Dockerfile).
    {
      provide: MIGRATIONS_DIR,
      useValue: join(process.cwd(), 'prisma', 'migrations'),
    },
  ],
})
export class HealthModule {}
