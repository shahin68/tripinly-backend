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
/** How long a rotated token may be presented again (its answer may have been lost). */
export const REUSE_GRACE_MS = 30 * 1000;

/**
 * Opaque 256-bit refresh tokens stored as SHA-256 hashes, rotated on every use.
 * Presenting a token that was already rotated revokes its whole family
 * (REFRESH_TOKEN_REUSED): someone else may hold a copy. The exception is a token
 * presented again within REUSE_GRACE_MS of its rotation whose successor is still
 * unused: the first answer probably never arrived, so the successor is rotated instead.
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
      const successor = await this.unusedSuccessorWithinGrace(current);
      const rotated = successor && (await this.replace(successor));
      if (rotated) return rotated;
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

    // Null when a concurrent refresh of the same token claimed it first; the
    // second pass then finds it just rotated and takes the grace path.
    return (await this.replace(current)) ?? this.rotate(presented);
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

  /** Claims `token` and issues its successor in the same family; null if already claimed. */
  private async replace(token: {
    id: string;
    userId: string;
    familyId: string;
    deviceLabel: string | null;
    authenticatedAt: Date;
  }): Promise<RotatedRefreshToken | null> {
    const next = randomToken();
    const expiresAt = new Date(Date.now() + this.ttlMs);
    const claimed = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.refreshToken.updateMany({
        where: { id: token.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (count === 0) return false;
      const created = await tx.refreshToken.create({
        data: {
          userId: token.userId,
          tokenHash: sha256Hex(next),
          familyId: token.familyId,
          expiresAt,
          deviceLabel: token.deviceLabel,
          authenticatedAt: token.authenticatedAt,
        },
      });
      await tx.refreshToken.update({
        where: { id: token.id },
        data: { replacedById: created.id },
      });
      return true;
    });
    if (!claimed) return null;
    return {
      token: next,
      expiresAt,
      userId: token.userId,
      authenticatedAt: token.authenticatedAt,
    };
  }

  private async unusedSuccessorWithinGrace(token: {
    revokedAt: Date | null;
    replacedById: string | null;
  }) {
    if (!token.revokedAt || !token.replacedById) return null;
    if (Date.now() - token.revokedAt.getTime() > REUSE_GRACE_MS) return null;
    const successor = await this.prisma.refreshToken.findUnique({
      where: { id: token.replacedById },
    });
    return successor && !successor.revokedAt && successor.expiresAt > new Date()
      ? successor
      : null;
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
