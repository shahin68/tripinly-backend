import {
  CallHandler,
  ExecutionContext,
  HttpStatus,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import { createHash } from 'node:crypto';
import { from, Observable, of, throwError } from 'rxjs';
import { catchError, mergeMap } from 'rxjs/operators';
import type { AuthenticatedRequest } from '../auth/auth.decorators';
import { AppException } from '../errors/app.exception';
import { ErrorCode } from '../errors/error-codes';
import { IDEMPOTENCY_HEADER, IDEMPOTENT } from './idempotent.decorator';
import { IdempotencyStore } from './idempotency.store';

const KEY_PATTERN = /^[\x21-\x7E]{1,255}$/;

/**
 * Runs a route marked `@Idempotent()` at most once per user and
 * `Idempotency-Key`. A retry with the same request replays the stored body; the
 * status code is the route's fixed success status. Failed requests free the key.
 * When Redis is unavailable the request runs without the guarantee.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger(IdempotencyInterceptor.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly store: IdempotencyStore,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const enabled = this.reflector.getAllAndOverride<boolean>(IDEMPOTENT, [
      context.getHandler(),
      context.getClass(),
    ]);
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = request.headers[IDEMPOTENCY_HEADER];
    if (!enabled || header === undefined || !request.user) {
      return next.handle();
    }
    const key = Array.isArray(header) ? header[0] : header;
    if (!KEY_PATTERN.test(key)) {
      throw AppException.validation({ 'Idempotency-Key': ['invalidKey'] });
    }
    const userId = request.user.id;
    const fingerprint = createHash('sha256')
      .update(request.method)
      .update('\0')
      .update(request.originalUrl)
      .update('\0')
      .update(JSON.stringify(request.body ?? null))
      .digest('hex');

    return from(this.begin(userId, key, fingerprint)).pipe(
      mergeMap((existing) => {
        if (existing === 'unavailable') return next.handle();
        if (existing) {
          if (existing.state === 'pending') {
            throw new AppException(
              ErrorCode.IDEMPOTENCY_KEY_IN_PROGRESS,
              HttpStatus.CONFLICT,
            );
          }
          if (existing.fingerprint !== fingerprint) {
            throw new AppException(
              ErrorCode.IDEMPOTENCY_KEY_REUSED,
              HttpStatus.UNPROCESSABLE_ENTITY,
            );
          }
          context
            .switchToHttp()
            .getResponse<Response>()
            .setHeader('Idempotent-Replayed', 'true');
          return of(existing.body ?? undefined);
        }
        return next.handle().pipe(
          mergeMap((body) =>
            from(
              this.store
                .complete(userId, key, fingerprint, body)
                .catch((error) => this.warn('store', error)),
            ).pipe(mergeMap(() => of(body))),
          ),
          catchError((error: unknown) =>
            from(
              this.store
                .release(userId, key)
                .catch((releaseError) => this.warn('release', releaseError)),
            ).pipe(mergeMap(() => throwError(() => error))),
          ),
        );
      }),
    );
  }

  private async begin(userId: string, key: string, fingerprint: string) {
    try {
      return await this.store.begin(userId, key, fingerprint);
    } catch (error) {
      this.warn('lock', error);
      return 'unavailable' as const;
    }
  }

  private warn(step: string, error: unknown): void {
    this.logger.warn(
      `Idempotency ${step} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
