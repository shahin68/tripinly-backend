import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiNoContentResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { timingSafeEqual } from 'node:crypto';
import { Public } from '../../common/auth/auth.decorators';
import type { Env } from '../../common/config/env';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { RevenueCatWebhookDto } from './revenuecat-webhook.dto';
import { RevenueCatWebhookService } from './revenuecat-webhook.service';

/** Called by RevenueCat, not by the apps. */
@ApiTags('billing')
@Controller('billing/revenuecat')
export class RevenueCatWebhookController {
  private readonly auth?: string;

  constructor(
    private readonly webhook: RevenueCatWebhookService,
    config: ConfigService<Env, true>,
  ) {
    this.auth = config.get('REVENUECAT_WEBHOOK_AUTH', { infer: true });
  }

  @Post('webhook')
  @Public()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'RevenueCat purchase events (called by RevenueCat, not the apps)',
    description:
      'Authorized by the Authorization header set in RevenueCat (REVENUECAT_WEBHOOK_AUTH). Reads the named customers from RevenueCat and writes their Tripinly Pro entitlements; 503 while REVENUECAT_API_KEY is unset, so RevenueCat retries.',
  })
  @ApiNoContentResponse()
  @ApiUnauthorizedResponse({
    description: 'UNAUTHENTICATED: wrong or missing Authorization',
  })
  async receive(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: RevenueCatWebhookDto,
  ): Promise<void> {
    if (!this.authorized(authorization)) {
      throw new AppException(
        ErrorCode.UNAUTHENTICATED,
        HttpStatus.UNAUTHORIZED,
      );
    }
    await this.webhook.handle(body.event);
  }

  private authorized(given: string | undefined): boolean {
    if (!this.auth || !given) return false;
    const a = Buffer.from(this.auth);
    const b = Buffer.from(given);
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
