import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { CoreModule } from '../common/core.module';
import { PrismaService } from '../common/prisma/prisma.service';
import { BillingModule } from '../modules/billing/billing.module';
import { EntitlementService } from '../modules/billing/entitlement.service';
import {
  PREMIUM_FEATURES,
  type PremiumFeatureKey,
} from '../modules/billing/entitlements';

@Module({ imports: [CoreModule, BillingModule] })
class GrantScriptModule {}

/**
 * Grants a premium feature without a purchase, for testing until the
 * RevenueCat webhook is live:
 *
 *   npm run entitlement:grant -- <username> best_route_realtime [days]
 *
 * Without days it never expires; 0 days revokes it.
 */
async function main(): Promise<void> {
  const [username, feature, days] = process.argv.slice(2);
  if (!username || !PREMIUM_FEATURES.includes(feature as PremiumFeatureKey)) {
    throw new Error(
      `usage: entitlement:grant <username> <${PREMIUM_FEATURES.join('|')}> [days]`,
    );
  }
  const app = await NestFactory.createApplicationContext(GrantScriptModule, {
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));
  try {
    const user = await app.get(PrismaService).user.findUnique({
      where: { username: username.toLowerCase() },
      select: { id: true },
    });
    if (!user) throw new Error(`no user @${username}`);
    const expiresAt =
      days === undefined
        ? null
        : new Date(Date.now() + Number(days) * 86_400_000);
    await app
      .get(EntitlementService)
      .grantManual(user.id, feature as PremiumFeatureKey, expiresAt);
    app
      .get(Logger)
      .log(
        `Granted ${feature} to @${username}${expiresAt ? ` until ${expiresAt.toISOString()}` : ''}`,
      );
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
