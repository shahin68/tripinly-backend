import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';
import type { Env } from '../../common/config/env';
import { ErrorCode } from '../../common/errors/error-codes';
import { REDIS } from '../../common/redis/redis.module';

export type RevocationReason =
  typeof ErrorCode.ACCOUNT_SUSPENDED | typeof ErrorCode.UNAUTHENTICATED;

const key = (userId: string) => `auth:revoked:${userId}`;

/**
 * Access tokens are stateless, so revoking refresh tokens leaves up to one
 * access-token lifetime of access. Suspension and deletion mark the user here
 * for that long, and the auth guard refuses their still-valid tokens.
 */
@Injectable()
export class SessionRevocationService {
  private readonly logger = new Logger(SessionRevocationService.name);
  private readonly ttlSeconds: number;

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    config: ConfigService<Env, true>,
  ) {
    // A little over the access-token lifetime, so no token outlives the mark.
    this.ttlSeconds =
      config.get('JWT_ACCESS_TTL_SECONDS', { infer: true }) + 60;
  }

  async revoke(userId: string, reason: RevocationReason): Promise<void> {
    try {
      await this.redis.set(key(userId), reason, 'EX', this.ttlSeconds);
    } catch (error) {
      // The account status and revoked refresh tokens still stop the user
      // within one access-token lifetime.
      this.logger.warn(`Could not mark sessions revoked: ${String(error)}`);
    }
  }

  /** The reason the user's sessions were revoked, or null. Fails open. */
  async reason(userId: string): Promise<RevocationReason | null> {
    try {
      const value = await this.redis.get(key(userId));
      return value === ErrorCode.ACCOUNT_SUSPENDED ||
        value === ErrorCode.UNAUTHENTICATED
        ? value
        : null;
    } catch {
      return null;
    }
  }
}
