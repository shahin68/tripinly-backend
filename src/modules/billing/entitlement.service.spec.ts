import type { ConfigService } from '@nestjs/config';
import type { Env } from '../../common/config/env';
import type { PrismaService } from '../../common/prisma/prisma.service';
import { EntitlementService } from './entitlement.service';

describe('EntitlementService', () => {
  /** A user with a dev identity [devIdentities] times and no entitlement rows. */
  function service(devAccountsPro: boolean, devIdentities: number) {
    const prisma = {
      authIdentity: { count: jest.fn().mockResolvedValue(devIdentities) },
      entitlement: {
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue([]),
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
});
