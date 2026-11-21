import type { ConfigService } from '@nestjs/config';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import type { Env } from '../../common/config/env';
import type { PrismaService } from '../../common/prisma/prisma.service';
import type { EntitlementService } from './entitlement.service';
import type {
  RevenueCatClient,
  RevenueCatSubscriber,
} from './revenuecat.client';
import { RevenueCatWebhookService } from './revenuecat-webhook.service';

const USER = '0b4f1f3e-8f9a-4c55-9d43-0d2b1a2c3d4e';

describe('RevenueCatWebhookService', () => {
  function setup(
    subscriber: Partial<RevenueCatSubscriber>,
    options: { deployEnv?: string; configured?: boolean } = {},
  ) {
    const tx = {
      entitlement: { upsert: jest.fn(), deleteMany: jest.fn() },
    };
    const prisma = {
      user: {
        findMany: jest.fn(({ where }: { where: { id: { in: string[] } } }) =>
          Promise.resolve(
            where.id.in.filter((id) => id === USER).map((id) => ({ id })),
          ),
        ),
      },
      $transaction: jest.fn((run: (client: typeof tx) => Promise<void>) =>
        run(tx),
      ),
    };
    const revenueCat = {
      configured: options.configured ?? true,
      getSubscriber: jest.fn().mockResolvedValue({
        entitlements: {},
        subscriptions: {},
        non_subscriptions: {},
        ...subscriber,
      }),
    };
    const config = {
      get: jest.fn().mockReturnValue(options.deployEnv ?? 'staging'),
    } as unknown as ConfigService<Env, true>;
    const entitlements = {
      status: jest.fn().mockResolvedValue({
        entitlements: ['routes'],
        proExpiresAt: new Date('2027-10-20T08:00:00Z'),
      }),
    };
    const events = { emit: jest.fn() };
    const service = new RevenueCatWebhookService(
      prisma as unknown as PrismaService,
      revenueCat as unknown as RevenueCatClient,
      entitlements as unknown as EntitlementService,
      events as unknown as EventEmitter2,
      config,
    );
    return { service, tx, revenueCat, entitlements, events };
  }

  const yearly = {
    entitlements: {
      tripinly_pro: {
        expires_date: '2027-10-20T08:00:00Z',
        grace_period_expires_date: null,
        product_identifier: 'yearly',
      },
    },
    subscriptions: { yearly: { is_sandbox: true } },
  };

  it('writes Pro until the subscription ends', async () => {
    const { service, tx } = setup(yearly);
    await service.handle({ type: 'INITIAL_PURCHASE', app_user_id: USER });
    expect(tx.entitlement.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          userId: USER,
          feature: 'routes',
          source: 'revenuecat',
          expiresAt: new Date('2027-10-20T08:00:00Z'),
          externalRef: 'yearly',
        }),
      }),
    );
  });

  it('writes a lifetime purchase without an end', async () => {
    const { service, tx } = setup({
      entitlements: {
        tripinly_pro: { expires_date: null, product_identifier: 'lifetime' },
      },
      non_subscriptions: { lifetime: [{ is_sandbox: false }] },
    });
    await service.handle({ type: 'NON_RENEWING_PURCHASE', app_user_id: USER });
    expect(tx.entitlement.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ expiresAt: null }),
      }),
    );
  });

  it('keeps Pro through the billing grace period', async () => {
    const { service, tx } = setup({
      ...yearly,
      entitlements: {
        tripinly_pro: {
          ...yearly.entitlements.tripinly_pro,
          grace_period_expires_date: '2027-11-03T08:00:00Z',
        },
      },
    });
    await service.handle({ type: 'BILLING_ISSUE', app_user_id: USER });
    expect(tx.entitlement.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          expiresAt: new Date('2027-11-03T08:00:00Z'),
        }),
      }),
    );
  });

  it('removes Pro the customer no longer has', async () => {
    const { service, tx } = setup({});
    await service.handle({ type: 'EXPIRATION', app_user_id: USER });
    expect(tx.entitlement.deleteMany).toHaveBeenCalledWith({
      where: { userId: USER, source: 'revenuecat' },
    });
    expect(tx.entitlement.upsert).not.toHaveBeenCalled();
  });

  it('ignores test purchases in production', async () => {
    const { service, tx } = setup(yearly, { deployEnv: 'production' });
    await service.handle({ type: 'INITIAL_PURCHASE', app_user_id: USER });
    expect(tx.entitlement.upsert).not.toHaveBeenCalled();
    expect(tx.entitlement.deleteMany).toHaveBeenCalled();
  });

  it('syncs both sides of a transfer and skips anonymous ids', async () => {
    const { service, revenueCat } = setup({});
    await service.handle({
      type: 'TRANSFER',
      transferred_from: ['$RCAnonymousID:abc'],
      transferred_to: [USER],
    });
    expect(revenueCat.getSubscriber).toHaveBeenCalledTimes(1);
    expect(revenueCat.getSubscriber).toHaveBeenCalledWith(USER);
  });

  it('does nothing for customers that are not our users', async () => {
    const { service, revenueCat } = setup(yearly, { configured: false });
    await service.handle({
      type: 'TEST',
      app_user_id: '7d9c6a52-1111-4222-8333-944455556666',
    });
    expect(revenueCat.getSubscriber).not.toHaveBeenCalled();
  });

  it('asks RevenueCat to retry while the API key is missing', async () => {
    const { service } = setup(yearly, { configured: false });
    await expect(
      service.handle({ type: 'INITIAL_PURCHASE', app_user_id: USER }),
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });

  it('tells the user’s devices their Pro after every sync', async () => {
    const { service, events } = setup(yearly);
    await service.handle({ type: 'RENEWAL', app_user_id: USER });
    expect(events.emit).toHaveBeenCalledWith(
      'pro.changed',
      expect.objectContaining({
        event: 'pro.changed',
        actorId: USER,
        data: {
          entitlements: ['routes'],
          proExpiresAt: '2027-10-20T08:00:00.000Z',
        },
      }),
    );
  });

  it('tells nobody when the event names none of our users', async () => {
    const { service, events } = setup(yearly);
    await service.handle({ type: 'TEST', app_user_id: '$RCAnonymousID:x' });
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('syncNow reads RevenueCat at once and answers the Pro it wrote', async () => {
    const { service, revenueCat, tx, events } = setup(yearly);
    await expect(service.syncNow(USER)).resolves.toEqual({
      entitlements: ['routes'],
      proExpiresAt: '2027-10-20T08:00:00.000Z',
    });
    expect(revenueCat.getSubscriber).toHaveBeenCalledWith(USER);
    expect(tx.entitlement.upsert).toHaveBeenCalled();
    expect(events.emit).toHaveBeenCalledTimes(1);
  });

  it('syncNow says 503 while RevenueCat is unset or failing, and writes nothing', async () => {
    const unset = setup(yearly, { configured: false });
    await expect(unset.service.syncNow(USER)).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
    const failing = setup(yearly);
    failing.revenueCat.getSubscriber.mockRejectedValueOnce(new Error('down'));
    await expect(failing.service.syncNow(USER)).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
    expect(failing.tx.entitlement.upsert).not.toHaveBeenCalled();
    expect(failing.events.emit).not.toHaveBeenCalled();
  });
});
