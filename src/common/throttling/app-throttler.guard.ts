import { ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { ThrottlerGuard, type ThrottlerLimitDetail } from '@nestjs/throttler';
import type { AuthenticatedRequest } from '../auth/auth.decorators';
import { AppException } from '../errors/app.exception';
import { ErrorCode } from '../errors/error-codes';

/**
 * Runs after the auth guard: signed-in callers are limited per user, everyone
 * else per IP (Express resolves the client IP via `trust proxy`).
 */
@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  /** HTTP only; the realtime gateway authenticates its own connections. */
  override canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return Promise.resolve(true);
    return super.canActivate(context);
  }

  protected override getTracker(req: Record<string, unknown>): Promise<string> {
    const request = req as unknown as AuthenticatedRequest;
    return Promise.resolve(
      request.user
        ? `user:${request.user.id}`
        : `ip:${request.ip ?? 'unknown'}`,
    );
  }

  protected override throwThrottlingException(
    _context: ExecutionContext,
    detail: ThrottlerLimitDetail,
  ): Promise<void> {
    throw new AppException(
      ErrorCode.RATE_LIMITED,
      HttpStatus.TOO_MANY_REQUESTS,
      {
        retryAfterSeconds: detail.timeToBlockExpire,
      },
    );
  }
}
