import type { ConfigService } from '@nestjs/config';
import type { Env } from '../../common/config/env';
import type { PrismaService } from '../../common/prisma/prisma.service';
import { EntitlementService } from './entitlement.service';

describe('EntitlementService', () => {
  /** A user with a dev identity [devIdentities] times and no entitlement rows. */
  function service(
    devAccountsPro: boolean,
    devIdentities: number,
    rows: { feature: string; expiresAt: Date | null }[] = [],
  ) {
    const prisma = {
      authIdentity: { count: jest.fn().mockResolvedValue(devIdentities) },
      entitlement: {
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue(rows),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(devAccountsPro),
    } as unknown as ConfigService<Env, true>;
    return new EntitlementService(prisma as unknown as PrismaService, config);
  }

  it('gives dev accounts every feature with DEV_ACCOUNTS_PRO', async () => {
    const entitlements = service(true, 1);
    await expect(entitlements.has('u1', 'routes')).resolves.toBe(true);
    await expect(entitlements.active('u1')).resolves.toEqual(['routes']);
  });

  it('leaves other accounts to their entitlements', async () => {
    const entitlements = service(true, 0);
    await expect(entitlements.has('u1', 'routes')).resolves.toBe(false);
    await expect(entitlements.active('u1')).resolves.toEqual([]);
  });

  it('gives dev accounts nothing extra without DEV_ACCOUNTS_PRO', async () => {
    const entitlements = service(false, 1);
    await expect(entitlements.has('u1', 'routes')).resolves.toBe(false);
  });

  describe('status', () => {
    const june = new Date('2027-06-01T00:00:00Z');
    const july = new Date('2027-07-01T00:00:00Z');

    it('has no Pro and no end without rows', async () => {
      await expect(service(false, 0).status('u1')).resolves.toEqual({
        entitlements: [],
        proExpiresAt: null,
      });
    });

    it('ends at the latest end of the active rows', async () => {
      const rows = [
        { feature: 'routes', expiresAt: june },
        { feature: 'routes', expiresAt: july },
      ];
      await expect(service(false, 0, rows).status('u1')).resolves.toEqual({
        entitlements: ['routes'],
        proExpiresAt: july,
      });
    });

    it('never ends when one active row never does', async () => {
      const rows = [
        { feature: 'routes', expiresAt: june },
        { feature: 'routes', expiresAt: null },
      ];
      await expect(service(false, 0, rows).status('u1')).resolves.toEqual({
        entitlements: ['routes'],
        proExpiresAt: null,
      });
    });

    it('ignores features the server no longer knows', async () => {
      const rows = [{ feature: 'retired', expiresAt: july }];
      await expect(service(false, 0, rows).status('u1')).resolves.toEqual({
        entitlements: [],
        proExpiresAt: null,
      });
    });

    it('never ends for dev accounts with DEV_ACCOUNTS_PRO', async () => {
      await expect(service(true, 1).status('u1')).resolves.toEqual({
        entitlements: ['routes'],
        proExpiresAt: null,
      });
    });
  });
});
