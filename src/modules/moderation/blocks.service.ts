import { HttpStatus, Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { domainEvent, DomainEvents } from '../../common/events/domain-events';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import {
  decodeCursor,
  DEFAULT_PAGE_SIZE,
  type Page,
  toPage,
} from '../../common/pagination/pagination';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { Prisma } from '../../generated/prisma/client';
import {
  toUserSummary,
  USER_SUMMARY_SELECT,
  type UserSummaryDto,
} from '../users/user-summary';

/**
 * Blocking is mutual in effect: every check looks at both directions. Other
 * modules use `isBlockedEither` for single checks and `notBlockedWith` to
 * filter lists in the database.
 */
@Injectable()
export class BlocksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
  ) {}

  async isBlockedEither(a: string, b: string): Promise<boolean> {
    if (a === b) return false;
    const count = await this.prisma.block.count({
      where: {
        OR: [
          { blockerId: a, blockedId: b },
          { blockerId: b, blockedId: a },
        ],
      },
    });
    return count > 0;
  }

  /** Which of `userIds` have a block with `userId` in either direction. */
  blockedAmong(userId: string, userIds: string[]): Promise<Set<string>> {
    return BlocksService.blockedAmong(this.prisma, userId, userIds);
  }

  /** `blockedAmong` for callers without the service (or inside a transaction). */
  static async blockedAmong(
    db: { block: Prisma.TransactionClient['block'] },
    userId: string,
    userIds: string[],
  ): Promise<Set<string>> {
    const others = [...new Set(userIds)].filter((id) => id !== userId);
    if (others.length === 0) return new Set();
    const rows = await db.block.findMany({
      where: {
        OR: [
          { blockerId: userId, blockedId: { in: others } },
          { blockedId: userId, blockerId: { in: others } },
        ],
      },
      select: { blockerId: true, blockedId: true },
    });
    return new Set(
      rows.map((row) =>
        row.blockerId === userId ? row.blockedId : row.blockerId,
      ),
    );
  }

  /** `where` fragment for users who have no block with `userId` in either direction. */
  static notBlockedWith(userId: string): Prisma.UserWhereInput {
    return {
      blocksGiven: { none: { blockedId: userId } },
      blocksReceived: { none: { blockerId: userId } },
    };
  }

  /**
   * Blocks `blockedId`. Also removes each user from the other's trips as an
   * editor. Idempotent.
   */
  async block(blockerId: string, blockedId: string): Promise<void> {
    if (blockerId === blockedId) {
      throw AppException.validation({ id: ['cannotBlockSelf'] });
    }
    const target = await this.prisma.user.findFirst({
      where: { id: blockedId, onboardedAt: { not: null } },
      select: { id: true },
    });
    if (!target) throw AppException.notFound();

    const removed = await this.prisma.$transaction(async (tx) => {
      await tx.block.upsert({
        where: { blockerId_blockedId: { blockerId, blockedId } },
        create: { blockerId, blockedId },
        update: {},
      });
      const memberships = await tx.tripMember.findMany({
        where: {
          role: 'editor',
          OR: [
            { userId: blockedId, trip: { ownerId: blockerId } },
            { userId: blockerId, trip: { ownerId: blockedId } },
          ],
        },
        select: { id: true, tripId: true, userId: true },
      });
      if (memberships.length > 0) {
        await tx.tripMember.deleteMany({
          where: { id: { in: memberships.map((m) => m.id) } },
        });
      }
      return memberships;
    });

    this.events.emit(
      DomainEvents.USER_BLOCKED,
      domainEvent(DomainEvents.USER_BLOCKED, blockerId, { blockedId }),
    );
    for (const membership of removed) {
      this.events.emit(
        DomainEvents.MEMBER_REMOVED,
        domainEvent(
          DomainEvents.MEMBER_REMOVED,
          blockerId,
          { userId: membership.userId, reason: 'blocked' },
          membership.tripId,
        ),
      );
    }
  }

  async unblock(blockerId: string, blockedId: string): Promise<void> {
    await this.prisma.block.deleteMany({ where: { blockerId, blockedId } });
  }

  /** Users the caller has blocked, newest first. */
  async listBlocked(
    blockerId: string,
    cursor?: string,
    limit = DEFAULT_PAGE_SIZE,
  ): Promise<Page<UserSummaryDto>> {
    const position = cursor ? decodeCursor(cursor) : undefined;
    const rows = await this.prisma.block.findMany({
      where: {
        blockerId,
        ...(position && {
          OR: [
            { createdAt: { lt: new Date(position.at) } },
            { createdAt: new Date(position.at), id: { lt: position.id } },
          ],
        }),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      include: { blocked: { select: USER_SUMMARY_SELECT } },
    });
    return toPage(
      rows,
      limit,
      (row) => ({ at: row.createdAt.toISOString(), id: row.id }),
      (row) => toUserSummary(row.blocked),
    );
  }
}

export function userBlockedError(): AppException {
  return new AppException(ErrorCode.USER_BLOCKED, HttpStatus.FORBIDDEN);
}
