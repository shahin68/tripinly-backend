import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { domainEvent, DomainEvents } from '../../common/events/domain-events';
import { AppException } from '../../common/errors/app.exception';
import {
  type CursorPosition,
  decodeCursor,
  DEFAULT_PAGE_SIZE,
  type Page,
  toPage,
} from '../../common/pagination/pagination';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { Prisma } from '../../generated/prisma/client';
import { BlocksService } from '../moderation/blocks.service';
import { TripAccessService } from '../trips/trip-access.service';
import { toUserSummary, USER_SUMMARY_SELECT } from '../users/user-summary';
import type { UrlSigner } from '../photos/photo-keys';
import { likedAmong } from './liked';
import { mentionedUsernames } from './mentions';
import type { CommentDto } from './social.dto';
import { StorageService } from '../../common/storage/storage.service';

const COMMENT_INCLUDE = {
  author: { select: USER_SUMMARY_SELECT },
  mentions: { select: { user: { select: { id: true, username: true } } } },
} satisfies Prisma.CommentInclude;

type CommentWithAuthor = Prisma.CommentGetPayload<{
  include: typeof COMMENT_INCLUDE;
}>;

/**
 * Plain-text comments on markers: main comments and one level of replies.
 * Anyone who can see a public trip may comment; comments from people with a
 * block with the viewer are left out, and nobody can comment on the markers
 * of someone they have a block with. A comment may @mention the trip's people.
 */
@Injectable()
export class CommentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TripAccessService,
    private readonly blocks: BlocksService,
    private readonly events: EventEmitter2,
    private readonly storage: StorageService,
  ) {}

  /** Main comments, most liked first, then newest first. */
  async list(
    userId: string,
    markerId: string,
    cursor?: string,
    limit = DEFAULT_PAGE_SIZE,
  ): Promise<Page<CommentDto>> {
    const { role } = await this.access.assertForMarker(
      userId,
      markerId,
      'view',
    );
    const position = cursor ? decodeCursor(cursor) : undefined;
    const rank = position?.rank ?? 0;
    const at = position && new Date(position.at);
    const rows = await this.prisma.comment.findMany({
      where: {
        markerId,
        parentId: null,
        ...this.shownTo(userId),
        ...(position &&
          at && {
            AND: {
              OR: [
                { likeCount: { lt: rank } },
                { likeCount: rank, createdAt: { lt: at } },
                { likeCount: rank, createdAt: at, id: { lt: position.id } },
              ],
            },
          }),
      },
      orderBy: [{ likeCount: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      include: COMMENT_INCLUDE,
    });
    return this.page(userId, role, rows, limit, (row) => ({
      at: row.createdAt.toISOString(),
      id: row.id,
      rank: row.likeCount,
    }));
  }

  /** A main comment's replies, oldest first. */
  async replies(
    userId: string,
    commentId: string,
    cursor?: string,
    limit = DEFAULT_PAGE_SIZE,
  ): Promise<Page<CommentDto>> {
    const parent = await this.shownComment(userId, commentId);
    const { role } = await this.access.assertForMarker(
      userId,
      parent.markerId,
      'view',
    );
    const position = cursor ? decodeCursor(cursor) : undefined;
    const rows = await this.prisma.comment.findMany({
      where: {
        parentId: parent.id,
        ...this.shownTo(userId),
        ...(position && {
          AND: {
            OR: [
              { createdAt: { gt: new Date(position.at) } },
              { createdAt: new Date(position.at), id: { gt: position.id } },
            ],
          },
        }),
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit + 1,
      include: COMMENT_INCLUDE,
    });
    return this.page(userId, role, rows, limit, (row) => ({
      at: row.createdAt.toISOString(),
      id: row.id,
    }));
  }

  async create(
    userId: string,
    markerId: string,
    body: string,
    parentId?: string,
  ): Promise<CommentDto> {
    const { trip, role } = await this.access.assertForMarker(
      userId,
      markerId,
      'comment',
    );
    const marker = await this.prisma.marker.findUniqueOrThrow({
      where: { id: markerId },
      select: { createdById: true },
    });
    if (
      marker.createdById &&
      (await this.blocks.isBlockedEither(userId, marker.createdById))
    ) {
      throw AppException.forbidden();
    }
    // A reply to a reply goes under the same main comment.
    const parent = parentId
      ? await this.shownComment(userId, parentId)
      : undefined;
    if (parent && parent.markerId !== markerId) throw AppException.notFound();
    const mainId = parent ? (parent.parentId ?? parent.id) : null;
    const mentionIds = await this.mentionable(userId, trip.id, body);

    const comment = await this.prisma.$transaction(async (tx) => {
      // Holds off a concurrent marker delete until the comment and count are in.
      const rows = await tx.$queryRaw<unknown[]>`
        SELECT 1 FROM markers WHERE id = ${markerId}::uuid FOR UPDATE`;
      if (rows.length === 0) throw AppException.notFound();
      if (mainId) {
        const main = await tx.$queryRaw<unknown[]>`
          SELECT 1 FROM comments WHERE id = ${mainId}::uuid FOR UPDATE`;
        if (main.length === 0) throw AppException.notFound();
      }
      const created = await tx.comment.create({
        data: {
          markerId,
          tripId: trip.id,
          authorId: userId,
          parentId: mainId,
          body,
          mentions: {
            create: mentionIds.map((id) => ({ userId: id })),
          },
        },
        include: COMMENT_INCLUDE,
      });
      await tx.$executeRaw`
        UPDATE markers SET "commentCount" = "commentCount" + 1 WHERE id = ${markerId}::uuid`;
      return created;
    });

    const dto = toCommentDto(
      comment,
      userId,
      role === 'owner',
      new Set(),
      new Map(),
      this.storage,
    );
    // Viewer-neutral for the trip room: likedByMe and canDelete are per viewer.
    const shared = toCommentDto(
      comment,
      '',
      false,
      new Set(),
      new Map(),
      this.storage,
    );
    this.events.emit(
      DomainEvents.COMMENT_CREATED,
      domainEvent(
        DomainEvents.COMMENT_CREATED,
        userId,
        {
          comment: shared,
          markerCreatorId: marker.createdById,
          tripOwnerId: trip.ownerId,
        },
        trip.id,
      ),
    );
    return dto;
  }

  /** The author (even after leaving the trip) or the trip owner. */
  async delete(userId: string, commentId: string): Promise<void> {
    const comment = await this.prisma.comment.findUnique({
      where: { id: commentId },
      select: { markerId: true, tripId: true, authorId: true },
    });
    if (!comment) throw AppException.notFound();
    if (comment.authorId !== userId) {
      const { role } = await this.access.assertForMarker(
        userId,
        comment.markerId,
        'view',
      );
      if (role !== 'owner') throw AppException.forbidden();
    }
    await this.remove(userId, { id: commentId, ...comment });
  }

  /**
   * Deletes a comment without an access check (moderation, account deletion,
   * and delete above). Returns false when it was already gone.
   */
  async remove(
    actorId: string,
    target: string | { id: string; markerId: string; tripId: string },
  ): Promise<boolean> {
    const comment =
      typeof target === 'string'
        ? await this.prisma.comment.findUnique({
            where: { id: target },
            select: { id: true, markerId: true, tripId: true },
          })
        : target;
    if (!comment) return false;
    const commentId = comment.id;

    // Its replies go with it (the foreign key cascades).
    const deletedIds = await this.prisma.$transaction(async (tx) => {
      const replies = await tx.comment.findMany({
        where: { parentId: commentId },
        select: { id: true },
      });
      const { count } = await tx.comment.deleteMany({
        where: { id: commentId },
      });
      if (count === 0) return [];
      const ids = [commentId, ...replies.map((reply) => reply.id)];
      await tx.$executeRaw`
        UPDATE markers SET "commentCount" = greatest(0, "commentCount" - ${ids.length})
        WHERE id = ${comment.markerId}::uuid`;
      return ids;
    });
    if (deletedIds.length === 0) return false;
    for (const id of deletedIds) {
      this.events.emit(
        DomainEvents.COMMENT_DELETED,
        domainEvent(
          DomainEvents.COMMENT_DELETED,
          actorId,
          { commentId: id, markerId: comment.markerId },
          comment.tripId,
        ),
      );
    }
    return true;
  }
  /** Comments the viewer sees: not hidden (unless theirs), no block either way. */
  private shownTo(userId: string): Prisma.CommentWhereInput {
    return {
      OR: [{ hiddenAt: null }, { authorId: userId }],
      author: BlocksService.notBlockedWith(userId),
    };
  }

  /** A comment the viewer sees, else not found (access is checked by the caller). */
  private async shownComment(
    userId: string,
    commentId: string,
  ): Promise<{ id: string; markerId: string; parentId: string | null }> {
    const comment = await this.prisma.comment.findFirst({
      where: { id: commentId, ...this.shownTo(userId) },
      select: { id: true, markerId: true, parentId: true },
    });
    if (!comment) throw AppException.notFound();
    return comment;
  }

  /** The trip's people (owner and members) the body @mentions, minus me and anyone with a block with me. */
  private async mentionable(
    userId: string,
    tripId: string,
    body: string,
  ): Promise<string[]> {
    const usernames = mentionedUsernames(body);
    if (usernames.length === 0) return [];
    const members = await this.prisma.tripMember.findMany({
      where: {
        tripId,
        userId: { not: userId },
        user: {
          username: { in: usernames },
          status: 'active',
          ...BlocksService.notBlockedWith(userId),
        },
      },
      select: { userId: true },
    });
    return members.map((member) => member.userId);
  }

  private async page(
    userId: string,
    role: string | null,
    rows: CommentWithAuthor[],
    limit: number,
    position: (row: CommentWithAuthor) => CursorPosition,
  ): Promise<Page<CommentDto>> {
    const kept = rows.slice(0, limit);
    const mains = kept.filter((row) => row.parentId === null);
    const [liked, replyCounts] = await Promise.all([
      likedAmong(this.prisma, userId, {
        type: 'comment',
        ids: kept.map((row) => row.id),
      }),
      mains.length
        ? this.prisma.comment.groupBy({
            by: ['parentId'],
            where: {
              parentId: { in: mains.map((row) => row.id) },
              ...this.shownTo(userId),
            },
            _count: { _all: true },
          })
        : [],
    ]);
    const counts = new Map(
      replyCounts.map((group) => [group.parentId!, group._count._all]),
    );
    return toPage(rows, limit, position, (row) =>
      toCommentDto(row, userId, role === 'owner', liked, counts, this.storage),
    );
  }
}

function toCommentDto(
  comment: CommentWithAuthor,
  viewerId: string,
  viewerOwnsTrip: boolean,
  likedIds: ReadonlySet<string>,
  replyCounts: ReadonlyMap<string, number>,
  signer: UrlSigner,
): CommentDto {
  return {
    id: comment.id,
    markerId: comment.markerId,
    body: comment.body,
    author: toUserSummary(comment.author, signer),
    likeCount: comment.likeCount,
    likedByMe: likedIds.has(comment.id),
    canDelete: viewerOwnsTrip || comment.authorId === viewerId,
    parentId: comment.parentId,
    replyCount: replyCounts.get(comment.id) ?? 0,
    mentions: comment.mentions.map(({ user }) => ({
      userId: user.id,
      username: user.username ?? '',
    })),
    createdAt: comment.createdAt.toISOString(),
  };
}
