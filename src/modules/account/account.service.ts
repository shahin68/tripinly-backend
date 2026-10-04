import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { AuthUser } from '../../common/auth/auth.decorators';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { domainEvent, DomainEvents } from '../../common/events/domain-events';
import { PrismaService } from '../../common/prisma/prisma.service';
import { StorageService } from '../../common/storage/storage.service';
import { type DataExport, Prisma } from '../../generated/prisma/client';
import { RefreshTokenService } from '../auth/refresh-token.service';
import { SessionRevocationService } from '../auth/session-revocation.service';
import type { AccountDeletionDto, DataExportDto } from './account.dto';
import { normalizeUsername } from '../users/username';
import { AccountJobsService } from './account.queue';
import { exportKey } from './export-keys';

/** Account deletion needs a Google/Apple sign-in this recent. */
export const REAUTH_WINDOW_MS = 10 * 60 * 1000;
/** One export per this period (account-deletion skill). */
export const EXPORT_INTERVAL_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class AccountService {
  private readonly logger = new Logger(AccountService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly refreshTokens: RefreshTokenService,
    private readonly revocations: SessionRevocationService,
    private readonly jobs: AccountJobsService,
    private readonly storage: StorageService,
    private readonly events: EventEmitter2,
  ) {}

  /**
   * DELETE /me: locks the account at once and hands the rest to the worker.
   * From here the user can't sign in, refresh, call the API or keep a socket.
   */
  async requestDeletion(user: AuthUser): Promise<AccountDeletionDto> {
    if (Date.now() - user.authTime.getTime() > REAUTH_WINDOW_MS) {
      throw new AppException(ErrorCode.REAUTH_REQUIRED, HttpStatus.FORBIDDEN);
    }
    await this.closeAndDelete(user.id, { releaseUsername: false });
    return { status: 'deleting' };
  }

  /**
   * DELETE /auth/dev/accounts (local and staging only): the same deletion
   * without a fresh sign-in, for a developer account by its dev subject or any
   * account by username. The username is freed at once instead of held, so
   * test names can be reused.
   */
  async deleteForDevelopment(
    target: { subject: string } | { username: string },
  ): Promise<AccountDeletionDto> {
    const user = await this.prisma.user.findFirst({
      where:
        'subject' in target
          ? {
              identities: {
                some: { provider: 'dev', providerSubject: target.subject },
              },
            }
          : { username: normalizeUsername(target.username) },
      select: { id: true, status: true },
    });
    if (!user) throw AppException.notFound();
    if (user.status === 'deleting') {
      // Already on its way out (the normal flow holds the username); nothing to change.
      return { status: 'deleting' };
    }
    await this.closeAndDelete(user.id, { releaseUsername: true });
    return { status: 'deleting' };
  }

  /** Locks the account, signs it out everywhere and queues the deletion. */
  private async closeAndDelete(
    userId: string,
    options: { releaseUsername: boolean },
  ): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.user.updateMany({
        where: { id: userId, status: { not: 'deleting' } },
        data: { status: 'deleting' },
      }),
      this.prisma.device.deleteMany({ where: { userId } }),
    ]);
    await this.refreshTokens.revokeAll(userId);
    await this.revocations.revoke(userId, ErrorCode.UNAUTHENTICATED);
    this.events.emit(
      DomainEvents.ACCOUNT_CLOSED,
      domainEvent(DomainEvents.ACCOUNT_CLOSED, userId, {
        userId,
        reason: 'deleted',
      }),
    );
    // If this fails the hourly sweep enqueues it; the account is locked either way.
    await this.jobs.delete(userId, options).catch((error: unknown) => {
      this.logger.warn(`Could not queue account deletion: ${String(error)}`);
    });
  }

  /**
   * POST /me/export: one at a time (a pending export is returned again) and
   * one per 24 hours.
   */
  async requestExport(userId: string): Promise<DataExportDto> {
    this.storage.assertEnabled();
    const latest = await this.latest(userId);
    if (latest?.status === 'pending') return this.toDto(latest);
    if (
      latest &&
      latest.status !== 'failed' &&
      Date.now() - latest.createdAt.getTime() < EXPORT_INTERVAL_MS
    ) {
      const retryAfterMs =
        latest.createdAt.getTime() + EXPORT_INTERVAL_MS - Date.now();
      throw new AppException(
        ErrorCode.RATE_LIMITED,
        HttpStatus.TOO_MANY_REQUESTS,
        { retryAfterSeconds: Math.ceil(retryAfterMs / 1000) },
      );
    }
    let created: DataExport;
    try {
      created = await this.prisma.dataExport.create({ data: { userId } });
    } catch (error) {
      // A concurrent request created the pending export first.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        return this.toDto((await this.latest(userId))!);
      }
      throw error;
    }
    await this.jobs.export(created.id);
    return this.toDto(created);
  }

  async latestExport(userId: string): Promise<DataExportDto> {
    const latest = await this.latest(userId);
    if (!latest) throw AppException.notFound();
    return this.toDto(latest);
  }

  private latest(userId: string): Promise<DataExport | null> {
    return this.prisma.dataExport.findFirst({
      where: { userId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  }

  private toDto(row: DataExport): DataExportDto {
    const remainingMs = row.expiresAt
      ? row.expiresAt.getTime() - Date.now()
      : 0;
    const ready = row.status === 'ready' && remainingMs > 0;
    return {
      id: row.id,
      status: row.status === 'ready' && !ready ? 'expired' : row.status,
      createdAt: row.createdAt.toISOString(),
      readyAt: row.readyAt?.toISOString() ?? null,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      bytes: row.bytes === null ? null : Number(row.bytes),
      downloadUrl: ready
        ? this.storage.signedGetUrlFor(
            exportKey(row.userId, row.id),
            remainingMs / 1000,
          )
        : null,
    };
  }
}
