import type { INestApplication } from '@nestjs/common';
import { Redis } from 'ioredis';
import request from 'supertest';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { REDIS } from '../../src/common/redis/redis.module';
import { createTestApp } from '../utils/create-test-app';

describe('Health (integration)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /v1/health reports liveness without touching dependencies', async () => {
    await request(app.getHttpServer())
      .get('/v1/health')
      .expect(200, { status: 'ok' });
  });

  it('GET /v1/health/ready reports Postgres and Redis as up', async () => {
    await request(app.getHttpServer())
      .get('/v1/health/ready')
      .expect(200, { status: 'ok', checks: { database: 'up', redis: 'up' } });
  });

  it('has the PostGIS and pg_trgm extensions installed by the first migration', async () => {
    const prisma = app.get(PrismaService);
    const rows = await prisma.$queryRaw<{ extname: string }[]>`
      SELECT extname FROM pg_extension WHERE extname IN ('postgis', 'pg_trgm') ORDER BY extname`;
    expect(rows.map((row) => row.extname)).toEqual(['pg_trgm', 'postgis']);
    const [point] = await prisma.$queryRaw<{ meters: number }[]>`
      SELECT ST_Distance(
        ST_GeogFromText('POINT(16.3725 48.2083)'),
        ST_GeogFromText('POINT(16.3738 48.2082)')
      ) AS meters`;
    expect(point.meters).toBeGreaterThan(80);
    expect(point.meters).toBeLessThan(120);
  });

  describe('when Redis is unreachable', () => {
    let degraded: INestApplication;

    beforeAll(async () => {
      degraded = await createTestApp({
        override: (builder) =>
          builder.overrideProvider(REDIS).useValue(
            new Redis('redis://127.0.0.1:1', {
              lazyConnect: true,
              maxRetriesPerRequest: 0,
              enableOfflineQueue: false,
              retryStrategy: () => null,
            }),
          ),
      });
    });

    afterAll(async () => {
      await degraded.close();
    });

    it('GET /v1/health/ready returns 503 SERVICE_UNAVAILABLE naming the failed check', async () => {
      const response = await request(degraded.getHttpServer())
        .get('/v1/health/ready')
        .expect(503);
      expect(response.body).toEqual({
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: expect.any(String),
          details: { checks: { database: 'up', redis: 'down' } },
        },
      });
    });
  });
});
