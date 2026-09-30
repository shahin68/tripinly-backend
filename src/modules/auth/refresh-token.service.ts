import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import type { Env } from '../../common/config/env';
import { randomToken, sha256Hex } from '../../common/crypto/crypto';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { PrismaService } from '../../common/prisma/prisma.service';

export interface IssuedRefreshToken {
  token: string;
  expiresAt: Date;
}

export interface RotatedRefreshToken extends IssuedRefreshToken {
  userId: string;
  /** When the user last actually signed in; carried along every rotation. */
  authenticatedAt: Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Opaque 256-bit refresh tokens stored as SHA-256 hashes, rotated on every use.
 * Presenting a token that was already rotated revokes its whole family
 * (REFRESH_TOKEN_REUSED): someone else may hold a copy.
 */
@Injectable()
export class RefreshTokenService {
  private readonly logger = new Logger(RefreshTokenService.name);
  private readonly ttlMs: number;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<Env, true>,
  ) {
    this.ttlMs = config.get('JWT_REFRESH_TTL_DAYS', { infer: true }) * DAY_MS;
  }

  /** Starts a new token family (a new sign-in). */
  async issue(
    userId: string,
    deviceLabel?: string,
  ): Promise<IssuedRefreshToken> {
    const token = randomToken();
    const expiresAt = new Date(Date.now() + this.ttlMs);
    await this.prisma.refreshToken.create({
      data: {
        userId,
        tokenHash: sha256Hex(token),
        familyId: randomUUID(),
        expiresAt,
        deviceLabel,
        authenticatedAt: new Date(),
      },
    });
    return { token, expiresAt };
  }

  async rotate(presented: string): Promise<RotatedRefreshToken> {
    const current = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: sha256Hex(presented) },
      include: { user: { select: { status: true } } },
    });
    if (!current) {
      throw new AppException(
        ErrorCode.UNAUTHENTICATED,
        HttpStatus.UNAUTHORIZED,
      );
    }
    // Suspension and deletion revoke every token; say why rather than "reused".
    if (current.user.status === 'suspended') {
      await this.revokeFamily(current.familyId);
      throw new AppException(ErrorCode.ACCOUNT_SUSPENDED, HttpStatus.FORBIDDEN);
    }
    if (current.user.status !== 'active') {
      throw new AppException(
        ErrorCode.UNAUTHENTICATED,
        HttpStatus.UNAUTHORIZED,
      );
    }
    if (current.revokedAt) {
      await this.revokeFamily(current.familyId, 'reuse of a rotated token');
      throw new AppException(
        ErrorCode.REFRESH_TOKEN_REUSED,
        HttpStatus.UNAUTHORIZED,
      );
    }
    if (current.expiresAt <= new Date()) {
      throw new AppException(
        ErrorCode.UNAUTHENTICATED,
        HttpStatus.UNAUTHORIZED,
      );
    }

    const token = randomToken();
    const expiresAt = new Date(Date.now() + this.ttlMs);
    const rotated = await this.prisma.$transaction(async (tx) => {
      // Claim the presented token atomically; a concurrent rotation loses here.
      const claimed = await tx.refreshToken.updateMany({
        where: { id: current.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (claimed.count === 0) return null;
      const next = await tx.refreshToken.create({
        data: {
          userId: current.userId,
          tokenHash: sha256Hex(token),
          familyId: current.familyId,
          expiresAt,
          deviceLabel: current.deviceLabel,
          authenticatedAt: current.authenticatedAt,
        },
      });
      await tx.refreshToken.update({
        where: { id: current.id },
        data: { replacedById: next.id },
      });
      return next;
    });

    if (!rotated) {
      await this.revokeFamily(current.familyId, 'concurrent reuse');
      throw new AppException(
        ErrorCode.REFRESH_TOKEN_REUSED,
        HttpStatus.UNAUTHORIZED,
      );
    }
    return {
      token,
      expiresAt,
      userId: current.userId,
      authenticatedAt: current.authenticatedAt,
    };
  }

  /**
   * Logout: revokes the presented token's family. Holding the refresh token is
   * the proof, so no access token is needed. Returns the owner, or null.
   */
  async revoke(presented: string): Promise<string | null> {
    const current = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: sha256Hex(presented) },
      select: { userId: true, familyId: true },
    });
    if (!current) return null;
    await this.revokeFamily(current.familyId);
    return current.userId;
  }

  /** Revokes every refresh token the user holds (suspension, deletion). */
  async revokeAll(userId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  private async revokeFamily(familyId: string, reason?: string): Promise<void> {
    const { count } = await this.prisma.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (reason) {
      this.logger.warn(
        `Revoked refresh token family (${reason}); ${count} token(s)`,
      );
    }
  }
}
