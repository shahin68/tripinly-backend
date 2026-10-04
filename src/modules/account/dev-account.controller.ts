import {
  Controller,
  Delete,
  Headers,
  HttpCode,
  HttpStatus,
  Query,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import {
  ApiAcceptedResponse,
  ApiHeader,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Public } from '../../common/auth/auth.decorators';
import { devSecretMatches } from '../../common/auth/dev-auth';
import type { Env } from '../../common/config/env';
import { AppException } from '../../common/errors/app.exception';
import { AUTH_RATE_LIMIT } from '../../common/throttling/throttling.module';
import { AccountDeletionDto, DevDeleteAccountQueryDto } from './account.dto';
import { AccountService } from './account.service';

/** Test-account cleanup next to the developer sign-in; same switch, same secret. */
@ApiTags('auth')
@Public()
@Throttle({ default: AUTH_RATE_LIMIT })
@Controller('auth/dev/accounts')
export class DevAccountController {
  private readonly devAuthEnabled: boolean;
  private readonly devAuthSecret?: string;

  constructor(
    private readonly account: AccountService,
    config: ConfigService<Env, true>,
  ) {
    this.devAuthEnabled = config.get('DEV_AUTH_ENABLED', { infer: true });
    this.devAuthSecret = config.get('DEV_AUTH_SECRET', { infer: true });
  }

  @Delete()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Delete a test account at once (development only)',
    description:
      'Only when DEV_AUTH_ENABLED=true (local and staging, never production); 404 otherwise, and where DEV_AUTH_SECRET is set the X-Dev-Auth-Secret header must match. Pass exactly one of subject (a developer account) or username (any account). Runs the full account deletion without a fresh sign-in and frees the username immediately instead of holding it for 30 days. 404 when no account matches.',
  })
  @ApiHeader({ name: 'X-Dev-Auth-Secret', required: false })
  @ApiAcceptedResponse({ type: AccountDeletionDto })
  delete(
    @Query() query: DevDeleteAccountQueryDto,
    @Headers('x-dev-auth-secret') secret?: string,
  ): Promise<AccountDeletionDto> {
    if (!this.devAuthEnabled || !devSecretMatches(this.devAuthSecret, secret)) {
      throw AppException.notFound();
    }
    const { subject, username } = query;
    if ((subject === undefined) === (username === undefined)) {
      throw AppException.validation({
        subject: ['exactlyOneOfSubjectOrUsername'],
        username: ['exactlyOneOfSubjectOrUsername'],
      });
    }
    return this.account.deleteForDevelopment(
      subject !== undefined
        ? { subject }
        : { username: username!.replace(/^@/, '') },
    );
  }
}
