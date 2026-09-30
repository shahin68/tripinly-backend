import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { Prisma } from '../../generated/prisma/client';
import { PREMIUM_FEATURES, type PremiumFeatureKey } from './entitlements';

/**
 * The only place premium access is decided. Reads the entitlements table
 * (kept current by the billing webhook, or the grant script for testing);
 * a client flag never unlocks anything.
 */
@Injectable()
export class EntitlementService {
  constructor(private readonly prisma: PrismaService) {}

  async has(userId: string, feature: PremiumFeatureKey): Promise<boolean> {
    const count = await this.prisma.entitlement.count({
      where: { userId, feature, ...active() },
    });
    return count > 0;
  }

  /** Active feature keys, for `GET /me`. */
  async active(userId: string): Promise<PremiumFeatureKey[]> {
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
