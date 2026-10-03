import { readdirSync } from 'node:fs';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { PrismaService } from '../../common/prisma/prisma.service';
import { REDIS } from '../../common/redis/redis.module';

export type DependencyStatus = 'up' | 'down';

export interface ReadinessReport {
  ready: boolean;
  checks: {
    database: DependencyStatus;
    redis: DependencyStatus;
    migrations: DependencyStatus;
  };
}

const CHECK_TIMEOUT_MS = 2_000;

/** Folder holding the migrations this build ships with (copied into the image). */
export const MIGRATIONS_DIR = Symbol('MIGRATIONS_DIR');

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);
  private readonly expectedMigrations: string[] | undefined;
  /** Applied migrations are never unapplied, so a passing check is cached. */
  private migrationsApplied = false;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(MIGRATIONS_DIR) migrationsDir: string,
  ) {
    this.expectedMigrations = this.listMigrations(migrationsDir);
  }

  async readiness(): Promise<ReadinessReport> {
    const [database, redis, migrations] = await Promise.all([
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
      this.check('migrations', () => this.checkMigrations()),
    ]);
    return {
      ready: database === 'up' && redis === 'up' && migrations === 'up',
      checks: { database, redis, migrations },
    };
  }

  /**
   * Every migration this build ships with is applied, and none failed. Catches a
   * deploy whose release step (`prisma migrate deploy`) did not run.
   */
  private async checkMigrations(): Promise<void> {
    if (this.migrationsApplied || !this.expectedMigrations) return;
    const rows = await this.prisma.$queryRaw<
      { migration_name: string; finished_at: Date | null }[]
    >`SELECT migration_name, finished_at FROM _prisma_migrations WHERE rolled_back_at IS NULL`;
    const failed = rows.filter((row) => !row.finished_at);
    if (failed.length > 0) {
      throw new Error(
        `failed: ${failed.map((row) => row.migration_name).join(', ')}`,
      );
    }
    const applied = new Set(rows.map((row) => row.migration_name));
    const pending = this.expectedMigrations.filter(
      (name) => !applied.has(name),
    );
    if (pending.length > 0) {
      throw new Error(`pending: ${pending.join(', ')}`);
    }
    this.migrationsApplied = true;
  }

  private listMigrations(dir: string): string[] | undefined {
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
    } catch {
      this.logger.warn(
        `No migrations folder at ${dir}; readiness skips the migration check`,
      );
      return undefined;
    }
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
