import { execFileSync } from 'node:child_process';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer } from 'testcontainers';

/**
 * Starts PostGIS and Redis with Testcontainers and applies migrations.
 * Set TEST_DATABASE_URL / TEST_REDIS_URL to reuse running services instead
 * (for example CI service containers or a local docker-compose stack).
 */
export default async function globalSetup(): Promise<void> {
  const containers: { stop: () => Promise<unknown> }[] = [];

  let databaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseUrl) {
    const postgres = await new PostgreSqlContainer(
      'postgis/postgis:16-3.4-alpine',
    )
      .withDatabase('tripinly_test')
      .start();
    containers.push(postgres);
    databaseUrl = postgres.getConnectionUri();
  }

  let redisUrl = process.env.TEST_REDIS_URL;
  if (!redisUrl) {
    const redis = await new GenericContainer('redis:7-alpine')
      .withExposedPorts(6379)
      .start();
    containers.push(redis);
    redisUrl = `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`;
  }

  Object.assign(process.env, {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: databaseUrl,
    REDIS_URL: redisUrl,
    JWT_ACCESS_SECRET:
      process.env.JWT_ACCESS_SECRET ??
      'test-only-access-token-secret-32-chars!',
    ENCRYPTION_KEY:
      process.env.ENCRYPTION_KEY ?? Buffer.alloc(32, 7).toString('base64'),
    DEV_AUTH_ENABLED: 'true',
    GOOGLE_CLIENT_IDS: 'test-google-client-id',
    // Apple verification uses a local key set in tests; the code exchange is stubbed.
    APPLE_BUNDLE_ID: 'com.tripinly.test',
    APPLE_TEAM_ID: 'TESTTEAM01',
    APPLE_KEY_ID: 'TESTKEY001',
    APPLE_PRIVATE_KEY: 'unused-in-tests',
  });

  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    env: process.env,
    stdio: 'pipe',
  });

  (
    globalThis as { __TEST_CONTAINERS__?: typeof containers }
  ).__TEST_CONTAINERS__ = containers;
}
