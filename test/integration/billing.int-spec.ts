import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import {
  RevenueCatClient,
  type RevenueCatSubscriber,
} from '../../src/modules/billing/revenuecat.client';
import {
  onboardedUser,
  publishLegalDocuments,
  resetState,
  type Session,
} from '../utils/auth-helpers';
import { createTestApp } from '../utils/create-test-app';

const AUTH = 'test-revenuecat-webhook-auth';

describe('Billing (integration)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let buyer: Session;
  const subscribers = new Map<string, RevenueCatSubscriber>();
  const revenueCat = {
    configured: true,
    getSubscriber: jest.fn((id: string) =>
      Promise.resolve(
        subscribers.get(id) ?? {
          entitlements: {},
          subscriptions: {},
          non_subscriptions: {},
        },
      ),
    ),
    deleteSubscriber: jest.fn().mockResolvedValue(true),
  };

  const webhook = (body: object, auth: string | null = AUTH) => {
    const call = request(app.getHttpServer()).post(
      '/v1/billing/revenuecat/webhook',
    );
    return (auth === null ? call : call.set('Authorization', auth)).send(body);
  };
  const entitlements = async () =>
    (
      await request(app.getHttpServer())
        .get('/v1/me')
        .auth(buyer.accessToken, { type: 'bearer' })
        .expect(200)
    ).body.entitlements;

  beforeAll(async () => {
    app = await createTestApp({
      override: (builder) =>
        builder.overrideProvider(RevenueCatClient).useValue(revenueCat),
    });
    prisma = app.get(PrismaService);
  });

  beforeEach(async () => {
    await resetState(app);
    await publishLegalDocuments(app);
    subscribers.clear();
    revenueCat.getSubscriber.mockClear();
    buyer = await onboardedUser(app, 'buyer');
  });

  afterAll(async () => {
    await app.close();
  });

  it('turns a purchase into Pro and an expiry back into free', async () => {
    subscribers.set(buyer.userId, {
      entitlements: {
        tripinly_pro: {
          expires_date: new Date(Date.now() + 86_400_000).toISOString(),
          product_identifier: 'monthly',
        },
      },
      subscriptions: { monthly: { is_sandbox: true } },
      non_subscriptions: {},
    });
    await webhook({
      api_version: '1.0',
      event: {
        type: 'INITIAL_PURCHASE',
        app_user_id: buyer.userId,
        price: 4.99,
      },
    }).expect(204);
    expect(await entitlements()).toEqual(['routes']);

    // Repeating the event changes nothing.
    await webhook({
      event: { type: 'INITIAL_PURCHASE', app_user_id: buyer.userId },
    }).expect(204);
    expect(
      await prisma.entitlement.count({ where: { userId: buyer.userId } }),
    ).toBe(1);

    subscribers.delete(buyer.userId);
    await webhook({
      event: { type: 'EXPIRATION', app_user_id: buyer.userId },
    }).expect(204);
    expect(await entitlements()).toEqual([]);
  });

  it('keeps a lifetime purchase forever', async () => {
    subscribers.set(buyer.userId, {
      entitlements: {
        tripinly_pro: { expires_date: null, product_identifier: 'lifetime' },
      },
      subscriptions: {},
      non_subscriptions: { lifetime: [{ is_sandbox: true }] },
    });
    await webhook({
      event: { type: 'NON_RENEWING_PURCHASE', app_user_id: buyer.userId },
    }).expect(204);
    const row = await prisma.entitlement.findFirstOrThrow({
      where: { userId: buyer.userId },
    });
    expect(row).toMatchObject({ source: 'revenuecat', expiresAt: null });
  });

  it('leaves manual grants alone', async () => {
    await prisma.entitlement.create({
      data: { userId: buyer.userId, feature: 'routes', source: 'manual' },
    });
    await webhook({
      event: { type: 'EXPIRATION', app_user_id: buyer.userId },
    }).expect(204);
    expect(await entitlements()).toEqual(['routes']);
  });

  it('answers events about unknown customers without asking RevenueCat', async () => {
    await webhook({
      event: { type: 'TEST', app_user_id: '$RCAnonymousID:123' },
    }).expect(204);
    expect(revenueCat.getSubscriber).not.toHaveBeenCalled();
  });

  it('refuses calls without the shared secret', async () => {
    const event = {
      event: { type: 'INITIAL_PURCHASE', app_user_id: buyer.userId },
    };
    const missing = await webhook(event, null).expect(401);
    expect(missing.body.error.code).toBe('UNAUTHENTICATED');
    await webhook(event, 'Bearer wrong').expect(401);
    await webhook(event, `${AUTH}x`).expect(401);
    expect(revenueCat.getSubscriber).not.toHaveBeenCalled();
  });

  it('accepts the shared secret with or without a Bearer prefix', async () => {
    const event = { event: { type: 'TEST', app_user_id: 'not-ours' } };
    await webhook(event, `Bearer ${AUTH}`).expect(204);
    await webhook(event, ` ${AUTH} `).expect(204);
  });

  it('refuses a body without an event', async () => {
    const response = await webhook({ api_version: '1.0' }).expect(400);
    expect(response.body.error.code).toBe('VALIDATION_FAILED');
  });
});
