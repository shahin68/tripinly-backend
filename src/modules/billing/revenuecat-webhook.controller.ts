import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
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
  private readonly logger = new Logger(RevenueCatWebhookController.name);
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
    const refusal = this.refusal(authorization);
    if (refusal) {
      this.logger.warn(`RevenueCat webhook refused: ${refusal}`);
      throw new AppException(
        ErrorCode.UNAUTHENTICATED,
        HttpStatus.UNAUTHORIZED,
      );
    }
    await this.webhook.handle(body.event);
  }

  /** Why the call is refused, or null when its secret matches. Never names the secret. */
  private refusal(given: string | undefined): string | null {
    if (!this.auth) return 'REVENUECAT_WEBHOOK_AUTH is not set on this service';
    if (!given) return 'the call has no Authorization header';
    const a = Buffer.from(secret(this.auth));
    const b = Buffer.from(secret(given));
    if (a.length === b.length && timingSafeEqual(a, b)) return null;
    return `the Authorization header doesn't match (${b.length} characters received)`;
  }
}

/** The shared secret, whether or not it was entered with a `Bearer ` prefix. */
function secret(value: string): string {
  return value.trim().replace(/^Bearer\s+/i, '');
}
