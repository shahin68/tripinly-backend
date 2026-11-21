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

  /** Active feature keys. */
  async active(userId: string): Promise<PremiumFeatureKey[]> {
    return (await this.status(userId)).entitlements;
  }

  /**
   * My Pro as `GET /me` and the `pro.changed` event tell it: the active
   * features, and when they end. `proExpiresAt` is the latest end of the
   * active rows; null when one never ends (lifetime, manual grant, dev
   * account) or when there is no Pro. The apps end Pro locally at that time;
   * a renewal arrives earlier through the webhook and `pro.changed`.
   */
  async status(userId: string): Promise<ProStatus> {
    if (await this.isProDevAccount(userId)) {
      return { entitlements: [...PREMIUM_FEATURES].sort(), proExpiresAt: null };
    }
    const known = new Set<string>(PREMIUM_FEATURES);
    const rows = (
      await this.prisma.entitlement.findMany({
        where: { userId, ...active() },
        select: { feature: true, expiresAt: true },
      })
    ).filter((row) => known.has(row.feature));
    const entitlements = [
      ...new Set(rows.map((row) => row.feature as PremiumFeatureKey)),
    ].sort();
    const ends = rows.map((row) => row.expiresAt);
    const proExpiresAt =
      ends.length === 0 || ends.includes(null)
        ? null
        : new Date(Math.max(...ends.map((end) => (end as Date).getTime())));
    return { entitlements, proExpiresAt };
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

/** Active premium features and when they end (see [EntitlementService.status]). */
export interface ProStatus {
  entitlements: PremiumFeatureKey[];
  proExpiresAt: Date | null;
}

function active(): Prisma.EntitlementWhereInput {
  return { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] };
}
