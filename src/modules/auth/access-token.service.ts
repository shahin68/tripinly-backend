import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { errors as joseErrors, jwtVerify, SignJWT } from 'jose';
import { randomUUID } from 'node:crypto';
import type { Env } from '../../common/config/env';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';

const ISSUER = 'tripinly';
const AUDIENCE = 'tripinly-app';

export interface AccessTokenClaims {
  sub: string;
  role: 'user' | 'admin';
  /** Onboarded at the time of issue. */
  onb: boolean;
}

export interface VerifiedAccessToken extends AccessTokenClaims {
  expiresAt: Date;
}

export interface IssuedAccessToken {
  token: string;
  expiresAt: Date;
}

/** HS256 JWTs with the claims from docs/knowledge/07-security-and-gdpr.md. */
@Injectable()
export class AccessTokenService {
  private readonly secret: Uint8Array;
  private readonly ttlSeconds: number;

  constructor(config: ConfigService<Env, true>) {
    this.secret = new TextEncoder().encode(
      config.get('JWT_ACCESS_SECRET', { infer: true }),
    );
    this.ttlSeconds = config.get('JWT_ACCESS_TTL_SECONDS', { infer: true });
  }

  async issue(claims: AccessTokenClaims): Promise<IssuedAccessToken> {
    const issuedAt = Math.floor(Date.now() / 1000);
    const expiresAt = issuedAt + this.ttlSeconds;
    const token = await new SignJWT({ role: claims.role, onb: claims.onb })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(claims.sub)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt(issuedAt)
      .setExpirationTime(expiresAt)
      .setJti(randomUUID())
      .sign(this.secret);
    return { token, expiresAt: new Date(expiresAt * 1000) };
  }

  async verify(token: string): Promise<VerifiedAccessToken> {
    try {
      const { payload } = await jwtVerify(token, this.secret, {
        issuer: ISSUER,
        audience: AUDIENCE,
        algorithms: ['HS256'],
      });
      if (
        typeof payload.sub !== 'string' ||
        (payload.role !== 'user' && payload.role !== 'admin') ||
        typeof payload.onb !== 'boolean' ||
        typeof payload.exp !== 'number'
      ) {
        throw new AppException(
          ErrorCode.UNAUTHENTICATED,
          HttpStatus.UNAUTHORIZED,
        );
      }
      return {
        sub: payload.sub,
        role: payload.role,
        onb: payload.onb,
        expiresAt: new Date(payload.exp * 1000),
      };
    } catch (error) {
      if (error instanceof joseErrors.JWTExpired) {
        throw new AppException(
          ErrorCode.TOKEN_EXPIRED,
          HttpStatus.UNAUTHORIZED,
        );
      }
      if (error instanceof AppException) throw error;
      throw new AppException(
        ErrorCode.UNAUTHENTICATED,
        HttpStatus.UNAUTHORIZED,
      );
    }
  }
}
