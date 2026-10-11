import { execFileSync } from 'node:child_process';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer } from 'testcontainers';
import { ORS_STUB_KEY, ORS_STUB_URL } from '../utils/ors-stub';
import { PHOTON_STUB_URL } from '../utils/photon-stub';

const S3_KEY = process.env.TEST_S3_ACCESS_KEY ?? 'minioadmin';
const S3_SECRET = process.env.TEST_S3_SECRET_KEY ?? 'minioadmin';
const TEST_BUCKET = 'tripinly-test';

async function createBucket(endpoint: string): Promise<void> {
  const client = new S3Client({
    region: 'auto',
    endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: S3_KEY, secretAccessKey: S3_SECRET },
  });
  try {
    await client.send(new CreateBucketCommand({ Bucket: TEST_BUCKET }));
  } catch (error) {
    const name = (error as { name?: string }).name;
    if (name !== 'BucketAlreadyOwnedByYou' && name !== 'BucketAlreadyExists')
      throw error;
  } finally {
    client.destroy();
  }
}

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

  // S3-compatible storage for photos: TEST_S3_ENDPOINT (CI, or a local
  // VersityGW / moto server), else a VersityGW container. VersityGW checks
  // signatures like R2, with region "auto".
  let s3Endpoint = process.env.TEST_S3_ENDPOINT;
  if (!s3Endpoint) {
    const s3 = await new GenericContainer('versity/versitygw:v1.8.0')
      .withEnvironment({
        ROOT_ACCESS_KEY: S3_KEY,
        ROOT_SECRET_KEY: S3_SECRET,
        VGW_REGION: 'auto',
        VGW_BACKEND: 'posix',
        VGW_BACKEND_ARG: '/tmp/vgw',
      })
      .withExposedPorts(7070)
      .start();
    containers.push(s3);
    s3Endpoint = `http://${s3.getHost()}:${s3.getMappedPort(7070)}`;
  }
  await createBucket(s3Endpoint);

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
    // test/utils/photon-stub.ts listens here.
    PHOTON_BASE_URL: PHOTON_STUB_URL,
    // test/utils/ors-stub.ts listens here.
    ORS_BASE_URL: ORS_STUB_URL,
    ORS_API_KEY: ORS_STUB_KEY,
    R2_ENDPOINT: s3Endpoint,
    R2_ACCESS_KEY_ID: S3_KEY,
    R2_SECRET_ACCESS_KEY: S3_SECRET,
    R2_BUCKET: TEST_BUCKET,
  });

  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    env: process.env,
    stdio: 'pipe',
  });

  (
    globalThis as { __TEST_CONTAINERS__?: typeof containers }
  ).__TEST_CONTAINERS__ = containers;
}
