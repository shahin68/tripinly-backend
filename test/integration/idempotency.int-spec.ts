import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { IdempotencyStore } from '../../src/common/idempotency/idempotency.store';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { REDIS } from '../../src/common/redis/redis.module';
import { api } from '../utils/api';
import {
  onboardedUser,
  publishLegalDocuments,
  resetState,
  type Session,
} from '../utils/auth-helpers';
import { createTestApp } from '../utils/create-test-app';

describe('Idempotency-Key (integration)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let as: ReturnType<typeof api>['as'];
  let alice: Session;
  let bob: Session;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    as = api(app).as;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetState(app);
    await publishLegalDocuments(app);
    alice = await onboardedUser(app, 'alice');
    bob = await onboardedUser(app, 'bob');
  });

  const createTrip = (
    session: Session,
    key: string | undefined,
    title = 'Vienna',
  ) => {
    const req = as(session).post('/v1/trips');
    return (key ? req.set('Idempotency-Key', key) : req).send({ title });
  };

  const tripCount = (session: Session) =>
    prisma.trip.count({ where: { ownerId: session.userId } });

  it('replays the first response for a retry with the same key and body', async () => {
    const key = randomUUID();
    const first = await createTrip(alice, key).expect(201);
    expect(first.headers['idempotent-replayed']).toBeUndefined();

    const retry = await createTrip(alice, key).expect(201);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.body).toEqual(first.body);
    expect(await tripCount(alice)).toBe(1);
  });

  it('creates a new resource for each request without a key', async () => {
    await createTrip(alice, undefined).expect(201);
    await createTrip(alice, undefined).expect(201);
    expect(await tripCount(alice)).toBe(2);
  });

  it('answers 422 IDEMPOTENCY_KEY_REUSED for the same key with a different body', async () => {
    const key = randomUUID();
    await createTrip(alice, key, 'Vienna').expect(201);
    const response = await createTrip(alice, key, 'Budapest').expect(422);
    expect(response.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await tripCount(alice)).toBe(1);
  });

  it('answers 409 IDEMPOTENCY_KEY_IN_PROGRESS while the first request runs', async () => {
    const key = randomUUID();
    // Lock the key the way a running request does.
    await app.get(IdempotencyStore).begin(alice.userId, key, 'running');

    const response = await createTrip(alice, key).expect(409);
    expect(response.body.error.code).toBe('IDEMPOTENCY_KEY_IN_PROGRESS');
  });

  it('scopes keys per user', async () => {
    const key = randomUUID();
    const mine = await createTrip(alice, key).expect(201);
    const theirs = await createTrip(bob, key).expect(201);
    expect(theirs.body.id).not.toBe(mine.body.id);
    expect(theirs.headers['idempotent-replayed']).toBeUndefined();
  });

  it('frees the key when the request fails, so a corrected retry goes through', async () => {
    const key = randomUUID();
    await createTrip(alice, key, '').expect(400);
    await createTrip(alice, key, 'Vienna').expect(201);
    expect(await tripCount(alice)).toBe(1);
  });

  it('rejects a malformed key with VALIDATION_FAILED', async () => {
    const response = await createTrip(alice, 'x'.repeat(256)).expect(400);
    expect(response.body.error).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { fields: { 'Idempotency-Key': ['invalidKey'] } },
    });
    expect(await tripCount(alice)).toBe(0);
  });

  it('purges a user’s stored responses for account deletion', async () => {
    await createTrip(alice, randomUUID()).expect(201);
    await createTrip(alice, randomUUID()).expect(201);
    await createTrip(bob, randomUUID()).expect(201);
    const redis = app.get<Redis>(REDIS);

    await app.get(IdempotencyStore).purgeUser(alice.userId);

    expect(await redis.keys(`idempotency:${alice.userId}:*`)).toEqual([]);
    expect(await redis.keys(`idempotency:${bob.userId}:*`)).toHaveLength(1);
  });
});
