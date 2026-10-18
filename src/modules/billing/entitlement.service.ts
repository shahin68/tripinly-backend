import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../common/config/env';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { Prisma } from '../../generated/prisma/client';
import { PREMIUM_FEATURES, type PremiumFeatureKey } from './entitlements';

/**
 * The only place premium access is decided. Reads the entitlements table
 * (kept current by the billing webhook, or the grant script for testing);
 * a client flag never unlocks anything. With DEV_ACCOUNTS_PRO (staging,
 * until the paywall exists), dev sign-in accounts have every feature.
 */
@Injectable()
export class EntitlementService {
  private readonly devAccountsPro: boolean;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<Env, true>,
  ) {
    this.devAccountsPro = config.get('DEV_ACCOUNTS_PRO', { infer: true });
  }

  async has(userId: string, feature: PremiumFeatureKey): Promise<boolean> {
    if (await this.isProDevAccount(userId)) return true;
    const count = await this.prisma.entitlement.count({
      where: { userId, feature, ...active() },
    });
    return count > 0;
  }

  /** Active feature keys, for `GET /me`. */
  async active(userId: string): Promise<PremiumFeatureKey[]> {
    if (await this.isProDevAccount(userId)) return [...PREMIUM_FEATURES].sort();
    const rows = await this.prisma.entitlement.findMany({
      where: { userId, ...active() },
      select: { feature: true },
      distinct: ['feature'],
    });
    const known = new Set<string>(PREMIUM_FEATURES);
    return rows
      .map((row) => row.feature)
      .filter((feature): feature is PremiumFeatureKey => known.has(feature))
      .sort();
  }

  private async isProDevAccount(userId: string): Promise<boolean> {
    if (!this.devAccountsPro) return false;
    const count = await this.prisma.authIdentity.count({
      where: { userId, provider: 'dev' },
    });
    return count > 0;
  }

  /** Grants a feature without a store purchase (testing, support). */
  async grantManual(
    userId: string,
    feature: PremiumFeatureKey,
    expiresAt: Date | null,
  ): Promise<void> {
    await this.prisma.entitlement.upsert({
      where: {
        userId_feature_source: { userId, feature, source: 'manual' },
      },
      create: { userId, feature, source: 'manual', expiresAt },
      update: { expiresAt },
    });
  }
}

function active(): Prisma.EntitlementWhereInput {
  return { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] };
}
