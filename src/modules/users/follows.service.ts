import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AppException } from '../../common/errors/app.exception';
import { domainEvent, DomainEvents } from '../../common/events/domain-events';
import {
  decodeCursor,
  DEFAULT_PAGE_SIZE,
  type Page,
  toPage,
} from '../../common/pagination/pagination';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { Prisma } from '../../generated/prisma/client';
import { BlocksService } from '../moderation/blocks.service';
import {
  toUserSummary,
  USER_SUMMARY_SELECT,
  type UserSummaryDto,
} from './user-summary';
import { StorageService } from '../../common/storage/storage.service';

/** What the viewer and a profile's owner are to each other, plus counts. */
export interface FollowState {
  followerCount: number;
  followingCount: number;
  isFollowing: boolean;
  followsMe: boolean;
  isFriend: boolean;
}

/**
 * One-way follows without approval; mutual follows are friends. Following
 * never grants access to anything (private trips stay members-only). Blocking
 * removes follows both ways (BlocksService.block), and no follow can be made
 * across a block.
 */
@Injectable()
export class FollowsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
    private readonly storage: StorageService,
  ) {}

  /** Users who appear to `viewerId` in follow lists and counts. */
  static visibleTo(viewerId: string): Prisma.UserWhereInput {
    return {
      status: 'active',
      onboardedAt: { not: null },
      ...BlocksService.notBlockedWith(viewerId),
    };
  }

  /** Idempotent. Unknown, suspended, deleting or blocked either way → 404. */
  async follow(followerId: string, followeeId: string): Promise<void> {
    if (followerId === followeeId) {
      throw AppException.validation({ id: ['cannotFollowSelf'] });
    }
    await this.requireFollowable(followerId, followeeId);
    const { count } = await this.prisma.follow.createMany({
      data: [{ followerId, followeeId }],
      skipDuplicates: true,
    });
    if (count > 0) {
      this.events.emit(
        DomainEvents.USER_FOLLOWED,
        domainEvent(DomainEvents.USER_FOLLOWED, followerId, { followeeId }),
      );
    }
  }

  /** Idempotent; works whatever the other user's state. */
  async unfollow(followerId: string, followeeId: string): Promise<void> {
    if (followerId === followeeId) {
      throw AppException.validation({ id: ['cannotFollowSelf'] });
    }
    const { count } = await this.prisma.follow.deleteMany({
      where: { followerId, followeeId },
    });
    if (count > 0) {
      this.events.emit(
        DomainEvents.USER_UNFOLLOWED,
        domainEvent(DomainEvents.USER_UNFOLLOWED, followerId, { followeeId }),
      );
    }
  }

  /** People I follow, most recently followed first. */
  async following(
    userId: string,
    cursor?: string,
    limit = DEFAULT_PAGE_SIZE,
  ): Promise<Page<UserSummaryDto>> {
    const position = cursor ? decodeCursor(cursor) : undefined;
    const rows = await this.prisma.follow.findMany({
      where: {
        followerId: userId,
        followee: FollowsService.visibleTo(userId),
        ...(position && {
          OR: [
            { createdAt: { lt: new Date(position.at) } },
            {
              createdAt: new Date(position.at),
              followeeId: { lt: position.id },
            },
          ],
        }),
      },
      orderBy: [{ createdAt: 'desc' }, { followeeId: 'desc' }],
      take: limit + 1,
      include: { followee: { select: USER_SUMMARY_SELECT } },
    });
    return toPage(
      rows,
      limit,
      (row) => ({ at: row.createdAt.toISOString(), id: row.followeeId }),
      (row) => toUserSummary(row.followee, this.storage),
    );
  }

  /** People who follow me, most recent first. */
  async followers(
    userId: string,
    cursor?: string,
    limit = DEFAULT_PAGE_SIZE,
  ): Promise<Page<UserSummaryDto>> {
    const position = cursor ? decodeCursor(cursor) : undefined;
    const rows = await this.prisma.follow.findMany({
      where: {
        followeeId: userId,
        follower: FollowsService.visibleTo(userId),
        ...(position && {
          OR: [
            { createdAt: { lt: new Date(position.at) } },
            {
              createdAt: new Date(position.at),
              followerId: { lt: position.id },
            },
          ],
        }),
      },
      orderBy: [{ createdAt: 'desc' }, { followerId: 'desc' }],
      take: limit + 1,
      include: { follower: { select: USER_SUMMARY_SELECT } },
    });
    return toPage(
      rows,
      limit,
      (row) => ({ at: row.createdAt.toISOString(), id: row.followerId }),
      (row) => toUserSummary(row.follower, this.storage),
    );
  }

  /** Mutual follows, by display name then id. */
  async friends(
    userId: string,
    cursor?: string,
    limit = DEFAULT_PAGE_SIZE,
  ): Promise<Page<UserSummaryDto>> {
    const position = cursor ? decodeNameCursor(cursor) : undefined;
    const users = await this.prisma.user.findMany({
      where: {
        ...FollowsService.visibleTo(userId),
        followers: { some: { followerId: userId } },
        following: { some: { followeeId: userId } },
        ...(position && {
          OR: [
            { displayName: { gt: position.name } },
            { displayName: position.name, id: { gt: position.id } },
          ],
        }),
      },
      orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
      take: limit + 1,
      select: USER_SUMMARY_SELECT,
    });
    const kept = users.slice(0, limit);
    const last = kept[kept.length - 1];
    return {
      items: kept.map((user) => toUserSummary(user, this.storage)),
      nextCursor:
        users.length > limit
          ? encodeNameCursor(last.displayName ?? '', last.id)
          : null,
    };
  }

  /**
   * Follow state between the viewer and `userId`. Counts leave out suspended
   * and deleting users and anyone with a block with the viewer.
   */
  async stateFor(viewerId: string, userId: string): Promise<FollowState> {
    const [followerCount, followingCount, mine] = await Promise.all([
      this.prisma.follow.count({
        where: {
          followeeId: userId,
          follower: FollowsService.visibleTo(viewerId),
        },
      }),
      this.prisma.follow.count({
        where: {
          followerId: userId,
          followee: FollowsService.visibleTo(viewerId),
        },
      }),
      viewerId === userId
        ? Promise.resolve([])
        : this.prisma.follow.findMany({
            where: {
              OR: [
                { followerId: viewerId, followeeId: userId },
                { followerId: userId, followeeId: viewerId },
              ],
            },
            select: { followerId: true },
          }),
    ]);
    const isFollowing = mine.some((row) => row.followerId === viewerId);
    const followsMe = mine.some((row) => row.followerId === userId);
    return {
      followerCount,
      followingCount,
      isFollowing,
      followsMe,
      isFriend: isFollowing && followsMe,
    };
  }

  private async requireFollowable(
    viewerId: string,
    userId: string,
  ): Promise<void> {
    const target = await this.prisma.user.findFirst({
      where: { id: userId, ...FollowsService.visibleTo(viewerId) },
      select: { id: true },
    });
    if (!target) throw AppException.notFound();
  }
}

function encodeNameCursor(name: string, id: string): string {
  return Buffer.from(JSON.stringify([name, id])).toString('base64url');
}

function decodeNameCursor(cursor: string): { name: string; id: string } {
  try {
    const [name, id] = JSON.parse(
      Buffer.from(cursor, 'base64url').toString(),
    ) as unknown[];
    if (
      typeof name === 'string' &&
      typeof id === 'string' &&
      /^[0-9a-f-]{36}$/i.test(id)
    ) {
      return { name, id };
    }
  } catch {
    // fall through
  }
  throw AppException.validation({ cursor: ['invalidCursor'] });
}
