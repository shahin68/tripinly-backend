import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isUUID } from 'class-validator';
import type { Env } from '../../common/config/env';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { PrismaService } from '../../common/prisma/prisma.service';
import { PREMIUM_FEATURES } from './entitlements';
import {
  RevenueCatClient,
  type RevenueCatSubscriber,
} from './revenuecat.client';

/** The RevenueCat entitlement that unlocks every premium feature. */
export const PRO_ENTITLEMENT = 'tripinly_pro';

/** The webhook event fields the backend reads; RevenueCat sends many more. */
export interface RevenueCatEvent {
  type?: unknown;
  app_user_id?: unknown;
  original_app_user_id?: unknown;
  aliases?: unknown;
  transferred_from?: unknown;
  transferred_to?: unknown;
}

/**
 * Keeps `entitlements` in step with RevenueCat. An event only says which
 * customers changed: their current state is fetched and written, so repeated
 * and out-of-order events end up the same.
 */
@Injectable()
export class RevenueCatWebhookService {
  private readonly logger = new Logger(RevenueCatWebhookService.name);
  private readonly acceptSandbox: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly revenueCat: RevenueCatClient,
    config: ConfigService<Env, true>,
  ) {
    this.acceptSandbox =
      config.get('DEPLOY_ENV', { infer: true }) !== 'production';
  }

  async handle(event: RevenueCatEvent): Promise<void> {
    const userIds = await this.knownUsers(event);
    if (userIds.length === 0) return;
    if (!this.revenueCat.configured) {
      // RevenueCat retries, so the purchase lands once the key is set.
      throw new AppException(
        ErrorCode.SERVICE_UNAVAILABLE,
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    for (const userId of userIds) {
      await this.sync(userId, await this.revenueCat.getSubscriber(userId));
    }
    this.logger.log(
      `RevenueCat ${String(event.type)}: synced ${userIds.length} customer(s)`,
    );
  }

  /** Our users named by the event; anonymous RevenueCat ids are skipped. */
  private async knownUsers(event: RevenueCatEvent): Promise<string[]> {
    const ids = new Set(
      [
        event.app_user_id,
        event.original_app_user_id,
        ...list(event.aliases),
        ...list(event.transferred_from),
        ...list(event.transferred_to),
      ].filter((id): id is string => typeof id === 'string' && isUUID(id)),
    );
    if (ids.size === 0) return [];
    const users = await this.prisma.user.findMany({
      where: { id: { in: [...ids] } },
      select: { id: true },
    });
    return users.map((user) => user.id);
  }

  private async sync(
    userId: string,
    subscriber: RevenueCatSubscriber,
  ): Promise<void> {
    const pro = subscriber.entitlements[PRO_ENTITLEMENT];
    const counts =
      pro &&
      (this.acceptSandbox || !isSandbox(subscriber, pro.product_identifier));
    await this.prisma.$transaction(async (tx) => {
      if (!counts) {
        await tx.entitlement.deleteMany({
          where: { userId, source: 'revenuecat' },
        });
        return;
      }
      const expiresAt = latest(pro.expires_date, pro.grace_period_expires_date);
      for (const feature of PREMIUM_FEATURES) {
        await tx.entitlement.upsert({
          where: {
            userId_feature_source: { userId, feature, source: 'revenuecat' },
          },
          create: {
            userId,
            feature,
            source: 'revenuecat',
            expiresAt,
            externalRef: pro.product_identifier,
          },
          update: { expiresAt, externalRef: pro.product_identifier },
        });
      }
    });
  }
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isSandbox(subscriber: RevenueCatSubscriber, product: string): boolean {
  const subscription = subscriber.subscriptions[product];
  if (subscription) return subscription.is_sandbox === true;
  return (subscriber.non_subscriptions[product] ?? []).every(
    (purchase) => purchase.is_sandbox === true,
  );
}

/** Null (lifetime) wins; otherwise the later of the expiry and the billing grace period. */
function latest(
  expires: string | null,
  grace: string | null | undefined,
): Date | null {
  if (expires === null) return null;
  const end = new Date(expires);
  if (!grace) return end;
  const graceEnd = new Date(grace);
  return graceEnd > end ? graceEnd : end;
}
