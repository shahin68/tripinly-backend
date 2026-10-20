import { Global, Module } from '@nestjs/common';
import { EntitlementService } from './entitlement.service';
import { RevenueCatClient } from './revenuecat.client';
import { RevenueCatWebhookController } from './revenuecat-webhook.controller';
import { RevenueCatWebhookService } from './revenuecat-webhook.service';

/** Entitlements, kept in step with RevenueCat purchases by its webhook. */
@Global()
@Module({
  controllers: [RevenueCatWebhookController],
  providers: [EntitlementService, RevenueCatClient, RevenueCatWebhookService],
  exports: [EntitlementService],
})
export class BillingModule {}
