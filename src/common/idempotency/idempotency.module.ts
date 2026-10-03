import { Global, Module } from '@nestjs/common';
import { IdempotencyStore } from './idempotency.store';

@Global()
@Module({
  providers: [IdempotencyStore],
  exports: [IdempotencyStore],
})
export class IdempotencyModule {}
