import { Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import { type AuthUser, CurrentUser } from '../../common/auth/auth.decorators';
import { PRO_SYNC_RATE_LIMIT } from '../../common/throttling/throttling.module';
import { ProStatusDto } from './billing.dto';
import { RevenueCatWebhookService } from './revenuecat-webhook.service';

@ApiTags('me')
@ApiBearerAuth()
@Controller('me/pro')
export class ProController {
  constructor(private readonly revenueCat: RevenueCatWebhookService) {}

  @Post('sync')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: PRO_SYNC_RATE_LIMIT })
  @ApiOperation({
    summary: 'Read my Pro from RevenueCat now (after a purchase or restore)',
    description:
      'Called once by the app right after the store says a purchase or restore went through, so Pro turns on without waiting for the webhook (which later writes the same). Answers my Pro as it now is; every device of mine also hears pro.changed. 503 SERVICE_UNAVAILABLE while RevenueCat is unset or unreachable: the webhook still brings it.',
  })
  @ApiOkResponse({ type: ProStatusDto })
  @ApiServiceUnavailableResponse({
    description: 'SERVICE_UNAVAILABLE: RevenueCat unset or unreachable',
  })
  sync(@CurrentUser() user: AuthUser): Promise<ProStatusDto> {
    return this.revenueCat.syncNow(user.id);
  }
}
