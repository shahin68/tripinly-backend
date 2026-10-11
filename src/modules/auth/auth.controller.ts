import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import {
  ApiHeader,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { I18nLang } from 'nestjs-i18n';
import { Public } from '../../common/auth/auth.decorators';
import { devSecretMatches } from '../../common/auth/dev-auth';
import type { Env } from '../../common/config/env';
import { AppException } from '../../common/errors/app.exception';
import { AUTH_RATE_LIMIT } from '../../common/throttling/throttling.module';
import {
  AppleSignInDto,
  AuthTokensDto,
  DevSignInDto,
  GoogleSignInDto,
  LogoutDto,
  RefreshDto,
} from './auth.dto';
import { AuthService } from './auth.service';
import { AppleIdentityVerifier } from './identity/apple-identity.verifier';
import { GoogleIdentityVerifier } from './identity/google-identity.verifier';

@ApiTags('auth')
@Public()
@Throttle({ default: AUTH_RATE_LIMIT })
@Controller('auth')
export class AuthController {
  private readonly devAuthEnabled: boolean;
  private readonly devAuthSecret?: string;

  constructor(
    private readonly auth: AuthService,
    private readonly google: GoogleIdentityVerifier,
    private readonly apple: AppleIdentityVerifier,
    config: ConfigService<Env, true>,
  ) {
    this.devAuthEnabled = config.get('DEV_AUTH_ENABLED', { infer: true });
    this.devAuthSecret = config.get('DEV_AUTH_SECRET', { infer: true });
  }

  @Post('google')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Sign in with Google; creates the account on first use',
  })
  @ApiOkResponse({ type: AuthTokensDto })
  async google_(
    @Body() body: GoogleSignInDto,
    @I18nLang() lang: string,
  ): Promise<AuthTokensDto> {
    const identity = await this.google.verify(body.idToken);
    return this.auth.signIn(identity, { locale: lang });
  }

  @Post('apple')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Sign in with Apple; creates the account on first use',
  })
  @ApiOkResponse({ type: AuthTokensDto })
  async apple_(
    @Body() body: AppleSignInDto,
    @I18nLang() lang: string,
  ): Promise<AuthTokensDto> {
    const identity = await this.apple.verify(body.identityToken);
    const name = [body.givenName, body.familyName].filter(Boolean).join(' ');
    const appleRefreshToken = await this.apple.exchangeAuthorizationCode(
      body.authorizationCode,
    );
    return this.auth.signIn(
      { ...identity, name: name || undefined },
      { locale: lang, appleRefreshToken },
    );
  }

  @Post('dev')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Development sign-in without a provider',
    description:
      'Only when DEV_AUTH_ENABLED=true (local and staging, never production); 404 otherwise. Where DEV_AUTH_SECRET is set (staging), the X-Dev-Auth-Secret header must match.',
  })
  @ApiHeader({ name: 'X-Dev-Auth-Secret', required: false })
  @ApiOkResponse({ type: AuthTokensDto })
  dev(
    @Body() body: DevSignInDto,
    @I18nLang() lang: string,
    @Headers('x-dev-auth-secret') secret?: string,
  ): Promise<AuthTokensDto> {
    if (!this.devAuthEnabled || !devSecretMatches(this.devAuthSecret, secret)) {
      throw AppException.notFound();
    }
    return this.auth.signIn(
      { provider: 'dev', subject: body.subject, name: body.name },
      { locale: lang },
    );
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Exchange a refresh token for new tokens',
    description:
      'Refresh tokens are single use. Presenting one twice revokes the whole session (REFRESH_TOKEN_REUSED).',
  })
  @ApiOkResponse({ type: AuthTokensDto })
  refresh(@Body() body: RefreshDto): Promise<AuthTokensDto> {
    return this.auth.refresh(body.refreshToken);
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'End this session and unregister the device from push',
  })
  @ApiNoContentResponse()
  logout(@Body() body: LogoutDto): Promise<void> {
    return this.auth.logout(body.refreshToken, body.fcmToken);
  }
}
