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
import {
  connect,
  realtimeUrl,
  sleep,
  type TestSocket,
} from '../utils/realtime';

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
  const me = async () =>
    (
      await request(app.getHttpServer())
        .get('/v1/me')
        .auth(buyer.accessToken, { type: 'bearer' })
        .expect(200)
    ).body as { entitlements: string[]; proExpiresAt: string | null };
  const entitlements = async () => (await me()).entitlements;
  const sync = (session: Session | null = buyer) => {
    const call = request(app.getHttpServer()).post('/v1/me/pro/sync');
    return session === null
      ? call
      : call.auth(session.accessToken, { type: 'bearer' });
  };
  /** RevenueCat's customer with Pro until [ends] (null: lifetime), in the grace period until [grace]. */
  const proUntil = (
    ends: Date | null,
    grace: Date | null = null,
  ): RevenueCatSubscriber => ({
    entitlements: {
      tripinly_pro: {
        expires_date: ends?.toISOString() ?? null,
        grace_period_expires_date: grace?.toISOString() ?? null,
        product_identifier: ends ? 'monthly' : 'lifetime',
      },
    },
    subscriptions: ends ? { monthly: { is_sandbox: true } } : {},
    non_subscriptions: ends ? {} : { lifetime: [{ is_sandbox: true }] },
  });
  const inDays = (days: number) => new Date(Date.now() + days * 86_400_000);
  const event = (type: string) => ({
    event: { type, app_user_id: buyer.userId },
  });
  const sockets: TestSocket[] = [];
  const open = async (session: Session) => {
    const socket = await connect(await realtimeUrl(app), session);
    sockets.push(socket);
    return socket;
  };

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

  afterEach(() => {
    while (sockets.length) sockets.pop()!.close();
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

  describe('Pro status, kept in step on every side', () => {
    it('tells GET /me when Pro ends, and null without Pro', async () => {
      expect(await me()).toMatchObject({
        entitlements: [],
        proExpiresAt: null,
      });
      const ends = inDays(30);
      subscribers.set(buyer.userId, proUntil(ends));
      await webhook(event('INITIAL_PURCHASE')).expect(204);
      expect(await me()).toEqual(
        expect.objectContaining({
          entitlements: ['routes'],
          proExpiresAt: ends.toISOString(),
        }),
      );
    });

    it('moves the end on a renewal, and to the grace period while billing retries', async () => {
      subscribers.set(buyer.userId, proUntil(inDays(1)));
      await webhook(event('INITIAL_PURCHASE')).expect(204);
      const renewed = inDays(31);
      subscribers.set(buyer.userId, proUntil(renewed));
      await webhook(event('RENEWAL')).expect(204);
      expect((await me()).proExpiresAt).toBe(renewed.toISOString());

      const grace = inDays(38);
      subscribers.set(buyer.userId, proUntil(inDays(31), grace));
      await webhook(event('BILLING_ISSUE')).expect(204);
      expect(await me()).toMatchObject({
        entitlements: ['routes'],
        proExpiresAt: grace.toISOString(),
      });
    });

    it('keeps Pro until the end after a cancellation, and ends it at once on a refund', async () => {
      const ends = inDays(20);
      subscribers.set(buyer.userId, proUntil(ends));
      await webhook(event('INITIAL_PURCHASE')).expect(204);
      // Cancelled: RevenueCat still has Pro until the period ends.
      await webhook(event('CANCELLATION')).expect(204);
      expect((await me()).proExpiresAt).toBe(ends.toISOString());
      // Refunded: RevenueCat no longer lists the entitlement.
      subscribers.delete(buyer.userId);
      await webhook(event('CANCELLATION')).expect(204);
      expect(await me()).toMatchObject({
        entitlements: [],
        proExpiresAt: null,
      });
    });

    it('has no end for a lifetime purchase or a manual grant without one', async () => {
      subscribers.set(buyer.userId, proUntil(null));
      await webhook(event('NON_RENEWING_PURCHASE')).expect(204);
      expect(await me()).toMatchObject({
        entitlements: ['routes'],
        proExpiresAt: null,
      });
    });

    it('takes the later end when a store purchase and a manual grant overlap', async () => {
      const grant = inDays(60);
      await prisma.entitlement.create({
        data: {
          userId: buyer.userId,
          feature: 'routes',
          source: 'manual',
          expiresAt: grant,
        },
      });
      subscribers.set(buyer.userId, proUntil(inDays(10)));
      await webhook(event('INITIAL_PURCHASE')).expect(204);
      expect((await me()).proExpiresAt).toBe(grant.toISOString());
    });

    it('treats an entitlement past its end as no Pro, even before the expiry webhook', async () => {
      await prisma.entitlement.create({
        data: {
          userId: buyer.userId,
          feature: 'routes',
          source: 'revenuecat',
          expiresAt: new Date(Date.now() - 1000),
        },
      });
      expect(await me()).toMatchObject({
        entitlements: [],
        proExpiresAt: null,
      });
    });

    it('POST /me/pro/sync reads RevenueCat now, without waiting for the webhook', async () => {
      const ends = inDays(365);
      subscribers.set(buyer.userId, proUntil(ends));
      const { body } = await sync().expect(200);
      expect(body).toEqual({
        entitlements: ['routes'],
        proExpiresAt: ends.toISOString(),
      });
      expect(revenueCat.getSubscriber).toHaveBeenCalledWith(buyer.userId);
      expect(await entitlements()).toEqual(['routes']);
      // The webhook arriving later writes the same.
      await webhook(event('INITIAL_PURCHASE')).expect(204);
      expect(
        await prisma.entitlement.count({ where: { userId: buyer.userId } }),
      ).toBe(1);
    });

    it('POST /me/pro/sync answers no Pro when nothing was bought', async () => {
      const { body } = await sync().expect(200);
      expect(body).toEqual({ entitlements: [], proExpiresAt: null });
    });

    it('POST /me/pro/sync needs a session and says 503 when RevenueCat fails', async () => {
      await sync(null).expect(401);
      revenueCat.getSubscriber.mockRejectedValueOnce(new Error('down'));
      const failed = await sync().expect(503);
      expect(failed.body.error.code).toBe('SERVICE_UNAVAILABLE');
    });

    it('sends my Pro to every device of mine on each change, and only mine', async () => {
      const phone = await open(buyer);
      const tablet = await open(buyer);
      const someoneElse = await open(await onboardedUser(app, 'other'));
      const ends = inDays(30);
      subscribers.set(buyer.userId, proUntil(ends));
      await webhook(event('INITIAL_PURCHASE')).expect(204);
      for (const socket of [phone, tablet]) {
        await socket.waitFor('pro.changed', (e) => {
          return (
            (e.data as { proExpiresAt: string | null }).proExpiresAt ===
            ends.toISOString()
          );
        });
      }

      subscribers.delete(buyer.userId);
      await webhook(event('EXPIRATION')).expect(204);
      const ended = await phone.waitFor('pro.changed', (e) => {
        return (e.data as { entitlements: string[] }).entitlements.length === 0;
      });
      expect(ended.data).toEqual({ entitlements: [], proExpiresAt: null });

      await sleep(200);
      // Only the connect snapshot reached the other user.
      expect(someoneElse.events('pro.changed')).toHaveLength(1);
      expect(someoneElse.events('pro.changed')[0].data).toEqual({
        entitlements: [],
        proExpiresAt: null,
      });
    });

    it('sends my Pro as it is now on every (re)connect', async () => {
      const ends = inDays(30);
      subscribers.set(buyer.userId, proUntil(ends));
      await webhook(event('INITIAL_PURCHASE')).expect(204);
      const socket = await open(buyer);
      const snapshot = await socket.waitFor('pro.changed');
      expect(snapshot.data).toEqual({
        entitlements: ['routes'],
        proExpiresAt: ends.toISOString(),
      });
    });

    it('sends pro.changed after POST /me/pro/sync too', async () => {
      const socket = await open(buyer);
      await socket.waitFor('pro.changed');
      subscribers.set(buyer.userId, proUntil(inDays(7)));
      await sync().expect(200);
      await socket.waitFor('pro.changed', (e) => {
        return (e.data as { entitlements: string[] }).entitlements.length === 1;
      });
    });
  });
});
