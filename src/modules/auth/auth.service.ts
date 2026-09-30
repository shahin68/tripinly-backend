import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../common/config/env';
import { encrypt } from '../../common/crypto/crypto';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { PrismaService } from '../../common/prisma/prisma.service';
import { Prisma, type User } from '../../generated/prisma/client';
import { DevicesService } from '../users/devices.service';
import { AccessTokenService } from './access-token.service';
import type { AuthTokensDto } from './auth.dto';
import { RefreshTokenService } from './refresh-token.service';
import type { VerifiedIdentity } from './identity/verified-identity';

const DISPLAY_NAME_MAX = 50;

export interface SignInOptions {
  /** Language of the request; becomes the new account's locale. */
  locale: string;
  /** Apple only: refresh token from the authorization code exchange. */
  appleRefreshToken?: string | null;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly encryptionKey: Buffer;

  constructor(
    private readonly prisma: PrismaService,
    private readonly accessTokens: AccessTokenService,
    private readonly refreshTokens: RefreshTokenService,
    private readonly devices: DevicesService,
    config: ConfigService<Env, true>,
  ) {
    this.encryptionKey = Buffer.from(
      config.get('ENCRYPTION_KEY', { infer: true }),
      'base64',
    );
  }

  /**
   * Finds the account for a verified provider identity, creating it on first
   * sign-in. Accounts are keyed by provider + subject only, never by email.
   */
  async signIn(
    identity: VerifiedIdentity,
    options: SignInOptions,
  ): Promise<AuthTokensDto> {
    const appleRefreshToken = options.appleRefreshToken
      ? encrypt(options.appleRefreshToken, this.encryptionKey)
      : undefined;

    const existing = await this.prisma.authIdentity.findUnique({
      where: {
        provider_providerSubject: {
          provider: identity.provider,
          providerSubject: identity.subject,
        },
      },
      include: { user: true },
    });

    let user: User;
    if (existing) {
      user = existing.user;
      this.assertCanSignIn(user);
      const changes: Prisma.AuthIdentityUpdateInput = {};
      if (identity.email && identity.email !== existing.email)
        changes.email = identity.email;
      if (appleRefreshToken) changes.appleRefreshToken = appleRefreshToken;
      if (Object.keys(changes).length > 0) {
        await this.prisma.authIdentity.update({
          where: { id: existing.id },
          data: changes,
        });
      }
    } else {
      user = await this.createAccount(
        identity,
        options.locale,
        appleRefreshToken,
      );
    }
    return this.issueTokens(user);
  }

  async refresh(refreshToken: string): Promise<AuthTokensDto> {
    const rotated = await this.refreshTokens.rotate(refreshToken);
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: rotated.userId },
    });
    const access = await this.accessTokens.issue({
      sub: user.id,
      role: user.role,
      onb: user.onboardedAt !== null,
      authTime: rotated.authenticatedAt,
    });
    return {
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt.toISOString(),
      refreshToken: rotated.token,
      refreshTokenExpiresAt: rotated.expiresAt.toISOString(),
      onboardingRequired: user.onboardedAt === null,
    };
  }

  async logout(refreshToken: string, fcmToken?: string): Promise<void> {
    const userId = await this.refreshTokens.revoke(refreshToken);
    if (userId && fcmToken) {
      await this.devices.remove(userId, fcmToken);
    }
  }

  private async createAccount(
    identity: VerifiedIdentity,
    locale: string,
    appleRefreshToken: string | undefined,
  ): Promise<User> {
    const displayName =
      identity.name?.trim().slice(0, DISPLAY_NAME_MAX) || null;
    try {
      const user = await this.prisma.user.create({
        data: {
          displayName,
          locale,
          identities: {
            create: {
              provider: identity.provider,
              providerSubject: identity.subject,
              email: identity.email,
              appleRefreshToken,
            },
          },
        },
      });
      this.logger.log(`Created account via ${identity.provider}`);
      return user;
    } catch (error) {
      // Two first sign-ins raced; the other one created the account.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const winner = await this.prisma.authIdentity.findUniqueOrThrow({
          where: {
            provider_providerSubject: {
              provider: identity.provider,
              providerSubject: identity.subject,
            },
          },
          include: { user: true },
        });
        this.assertCanSignIn(winner.user);
        return winner.user;
      }
      throw error;
    }
  }

  private assertCanSignIn(user: User): void {
    if (user.status === 'suspended') {
      throw new AppException(ErrorCode.ACCOUNT_SUSPENDED, HttpStatus.FORBIDDEN);
    }
    if (user.status !== 'active') {
      throw new AppException(
        ErrorCode.UNAUTHENTICATED,
        HttpStatus.UNAUTHORIZED,
      );
    }
  }

  private async issueTokens(user: User): Promise<AuthTokensDto> {
    const [access, refresh] = await Promise.all([
      this.accessTokens.issue({
        sub: user.id,
        role: user.role,
        onb: user.onboardedAt !== null,
        authTime: new Date(),
      }),
      this.refreshTokens.issue(user.id),
    ]);
    return {
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt.toISOString(),
      refreshToken: refresh.token,
      refreshTokenExpiresAt: refresh.expiresAt.toISOString(),
      onboardingRequired: user.onboardedAt === null,
    };
  }
}
