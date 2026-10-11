import {
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createRemoteJWKSet,
  importPKCS8,
  jwtVerify,
  SignJWT,
  type JWTVerifyGetKey,
} from 'jose';
import type { Env } from '../../../common/config/env';
import { AppException } from '../../../common/errors/app.exception';
import { ErrorCode } from '../../../common/errors/error-codes';
import type { VerifiedIdentity } from './verified-identity';

export const APPLE_ISSUER = 'https://appleid.apple.com';
const APPLE_TOKEN_URL = 'https://appleid.apple.com/auth/token';
const APPLE_REVOKE_URL = 'https://appleid.apple.com/auth/revoke';
const HTTP_TIMEOUT_MS = 5_000;

/** Lets tests supply a local key set instead of Apple's JWKS endpoint. */
export const APPLE_JWKS = Symbol('APPLE_JWKS');

interface AppleConfig {
  bundleId: string;
  teamId: string;
  keyId: string;
  privateKey: string;
}

/**
 * Verifies Apple identity tokens against Apple's JWKS (`iss`, `aud` = bundle ID)
 * and exchanges the authorization code for a refresh token, which account
 * deletion needs to revoke the Apple session.
 */
@Injectable()
export class AppleIdentityVerifier {
  private readonly logger = new Logger(AppleIdentityVerifier.name);
  private readonly apple?: AppleConfig;
  private readonly keySet: JWTVerifyGetKey;

  constructor(
    config: ConfigService<Env, true>,
    @Optional() @Inject(APPLE_JWKS) keySet?: JWTVerifyGetKey,
  ) {
    const bundleId = config.get('APPLE_BUNDLE_ID', { infer: true });
    const teamId = config.get('APPLE_TEAM_ID', { infer: true });
    const keyId = config.get('APPLE_KEY_ID', { infer: true });
    const privateKey = config.get('APPLE_PRIVATE_KEY', { infer: true });
    if (bundleId && teamId && keyId && privateKey) {
      this.apple = {
        bundleId,
        teamId,
        keyId,
        privateKey: privateKey.replace(/\\n/g, '\n'),
      };
    }
    this.keySet =
      keySet ?? createRemoteJWKSet(new URL(`${APPLE_ISSUER}/auth/keys`));
  }

  get isConfigured(): boolean {
    return this.apple !== undefined;
  }

  async verify(identityToken: string): Promise<VerifiedIdentity> {
    const apple = this.requireConfig();
    try {
      const { payload } = await jwtVerify(identityToken, this.keySet, {
        issuer: APPLE_ISSUER,
        audience: apple.bundleId,
      });
      if (typeof payload.sub !== 'string' || !payload.sub) {
        throw new Error('missing subject');
      }
      return {
        provider: 'apple',
        subject: payload.sub,
        email: typeof payload.email === 'string' ? payload.email : undefined,
      };
    } catch (error) {
      this.logger.debug(
        `Apple identity token rejected: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new AppException(
        ErrorCode.UNAUTHENTICATED,
        HttpStatus.UNAUTHORIZED,
        {
          reason: 'invalid_identity_token',
        },
      );
    }
  }

  /**
   * Returns Apple's refresh token, or null when the exchange fails. Sign-in
   * still succeeds; the next sign-in sends a fresh code and we retry.
   */
  async exchangeAuthorizationCode(code: string): Promise<string | null> {
    const apple = this.requireConfig();
    try {
      const response = await fetch(APPLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          client_id: apple.bundleId,
          client_secret: await this.clientSecret(apple),
        }),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(`Apple token endpoint returned ${response.status}`);
      }
      const body = (await response.json()) as { refresh_token?: unknown };
      return typeof body.refresh_token === 'string' ? body.refresh_token : null;
    } catch (error) {
      this.logger.warn(
        `Apple authorization code exchange failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * Revokes the user's Apple session (account deletion). Returns whether Apple
   * accepted it; failures are logged without the token and not thrown, since
   * the account is deleted either way.
   */
  async revoke(refreshToken: string): Promise<boolean> {
    if (!this.apple) {
      this.logger.warn(
        'Apple revocation skipped: Sign in with Apple is not configured',
      );
      return false;
    }
    try {
      const response = await fetch(APPLE_REVOKE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          token: refreshToken,
          token_type_hint: 'refresh_token',
          client_id: this.apple.bundleId,
          client_secret: await this.clientSecret(this.apple),
        }),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(`Apple revoke endpoint returned ${response.status}`);
      }
      this.logger.log('Revoked an Apple session');
      return true;
    } catch (error) {
      this.logger.warn(
        `Apple revocation failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  private async clientSecret(apple: AppleConfig): Promise<string> {
    const key = await importPKCS8(apple.privateKey, 'ES256');
    return new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: apple.keyId })
      .setIssuer(apple.teamId)
      .setSubject(apple.bundleId)
      .setAudience(APPLE_ISSUER)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(key);
  }

  private requireConfig(): AppleConfig {
    if (!this.apple) {
      throw new AppException(
        ErrorCode.SERVICE_UNAVAILABLE,
        HttpStatus.SERVICE_UNAVAILABLE,
        {
          provider: 'apple',
        },
      );
    }
    return this.apple;
  }
}
