import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OAuth2Client } from 'google-auth-library';
import type { Env } from '../../../common/config/env';
import { AppException } from '../../../common/errors/app.exception';
import { ErrorCode } from '../../../common/errors/error-codes';
import type { VerifiedIdentity } from './verified-identity';

const GOOGLE_ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];

/** Verifies Google ID tokens: signature, `iss`, `exp` and `aud` ∈ GOOGLE_CLIENT_IDS. */
@Injectable()
export class GoogleIdentityVerifier {
  private readonly logger = new Logger(GoogleIdentityVerifier.name);
  private readonly audiences: string[];
  private readonly client = new OAuth2Client();

  constructor(config: ConfigService<Env, true>) {
    this.audiences = (config.get('GOOGLE_CLIENT_IDS', { infer: true }) ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);
  }

  get isConfigured(): boolean {
    return this.audiences.length > 0;
  }

  async verify(idToken: string): Promise<VerifiedIdentity> {
    if (!this.isConfigured) {
      throw new AppException(
        ErrorCode.SERVICE_UNAVAILABLE,
        HttpStatus.SERVICE_UNAVAILABLE,
        {
          provider: 'google',
        },
      );
    }
    try {
      const ticket = await this.client.verifyIdToken({
        idToken,
        audience: this.audiences,
      });
      const payload = ticket.getPayload();
      if (!payload?.sub || !GOOGLE_ISSUERS.includes(payload.iss)) {
        throw new Error('missing subject or unexpected issuer');
      }
      return {
        provider: 'google',
        subject: payload.sub,
        email: payload.email,
        name: payload.name,
      };
    } catch (error) {
      this.logger.debug(
        `Google ID token rejected: ${error instanceof Error ? error.message : String(error)}`,
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
}
