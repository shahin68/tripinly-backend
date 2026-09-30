import { Global, Module } from '@nestjs/common';
import { EntitlementService } from './entitlement.service';

/** Entitlements now; the RevenueCat webhook joins once the app is deployed. */
@Global()
@Module({
  providers: [EntitlementService],
  exports: [EntitlementService],
})
export class BillingModule {}
