import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { PrismaService } from '../../common/prisma/prisma.service';
import { REDIS } from '../../common/redis/redis.module';

export type DependencyStatus = 'up' | 'down';

export interface ReadinessReport {
  ready: boolean;
  checks: { database: DependencyStatus; redis: DependencyStatus };
}

const CHECK_TIMEOUT_MS = 2_000;

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async readiness(): Promise<ReadinessReport> {
    const [database, redis] = await Promise.all([
      this.check('database', () => this.prisma.$queryRaw`SELECT 1`),
      this.check('redis', async () => {
        if (this.redis.status === 'wait') {
          await this.redis.connect();
        } else if (
          this.redis.status === 'connecting' ||
          this.redis.status === 'connect'
        ) {
          // Bootstrap started connecting; the probe timeout bounds this wait.
          await new Promise((resolve) => this.redis.once('ready', resolve));
        }
        await this.redis.ping();
      }),
    ]);
    return {
      ready: database === 'up' && redis === 'up',
      checks: { database, redis },
    };
  }

  private async check(
    name: string,
    probe: () => Promise<unknown>,
  ): Promise<DependencyStatus> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('timed out')),
        CHECK_TIMEOUT_MS,
      );
    });
    try {
      await Promise.race([probe(), timeout]);
      return 'up';
    } catch (error) {
      this.logger.warn(
        `Readiness check "${name}" failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 'down';
    } finally {
      clearTimeout(timer);
    }
  }
}
