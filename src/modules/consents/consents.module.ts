import { Module } from '@nestjs/common';
import { ConsentsService } from './consents.service';
import { LegalController } from './legal.controller';

@Module({
  controllers: [LegalController],
  providers: [ConsentsService],
  exports: [ConsentsService],
})
export class ConsentsModule {}
