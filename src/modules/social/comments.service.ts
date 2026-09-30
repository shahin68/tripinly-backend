import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { domainEvent, DomainEvents } from '../../common/events/domain-events';
import { AppException } from '../../common/errors/app.exception';
import {
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
import { likedAmong } from './liked';
import type { CommentDto } from './social.dto';

const COMMENT_INCLUDE = {
  author: { select: USER_SUMMARY_SELECT },
} satisfies Prisma.CommentInclude;

type CommentWithAuthor = Prisma.CommentGetPayload<{
  include: typeof COMMENT_INCLUDE;
}>;

/**
 * Flat, plain-text comments on markers. Anyone who can see a public trip may
 * comment; comments from people with a block with the viewer are left out,
 * and nobody can comment on the markers of someone they have a block with.
 */
@Injectable()
export class CommentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TripAccessService,
    private readonly blocks: BlocksService,
    private readonly events: EventEmitter2,
  ) {}

  /** Oldest first. */
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
    const rows = await this.prisma.comment.findMany({
      where: {
        markerId,
        OR: [{ hiddenAt: null }, { authorId: userId }],
        author: BlocksService.notBlockedWith(userId),
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
    const liked = await likedAmong(this.prisma, userId, {
      type: 'comment',
      ids: rows.map((row) => row.id),
    });
    return toPage(
      rows,
      limit,
      (row) => ({ at: row.createdAt.toISOString(), id: row.id }),
      (row) => toCommentDto(row, userId, role === 'owner', liked),
    );
  }

  async create(
    userId: string,
    markerId: string,
    body: string,
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

    const comment = await this.prisma.$transaction(async (tx) => {
      // Holds off a concurrent marker delete until the comment and count are in.
      const rows = await tx.$queryRaw<unknown[]>`
        SELECT 1 FROM markers WHERE id = ${markerId}::uuid FOR UPDATE`;
      if (rows.length === 0) throw AppException.notFound();
      const created = await tx.comment.create({
        data: { markerId, tripId: trip.id, authorId: userId, body },
        include: COMMENT_INCLUDE,
      });
      await tx.$executeRaw`
        UPDATE markers SET "commentCount" = "commentCount" + 1 WHERE id = ${markerId}::uuid`;
      return created;
    });

    const dto = toCommentDto(comment, userId, role === 'owner', new Set());
    // Viewer-neutral for the trip room: likedByMe and canDelete are per viewer.
    const shared = toCommentDto(comment, '', false, new Set());
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

    const deleted = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.comment.deleteMany({
        where: { id: commentId },
      });
      if (count > 0) {
        await tx.$executeRaw`
          UPDATE markers SET "commentCount" = greatest(0, "commentCount" - 1)
          WHERE id = ${comment.markerId}::uuid`;
      }
      return count > 0;
    });
    if (!deleted) return;
    this.events.emit(
      DomainEvents.COMMENT_DELETED,
      domainEvent(
        DomainEvents.COMMENT_DELETED,
        userId,
        { commentId, markerId: comment.markerId },
        comment.tripId,
      ),
    );
  }
}

function toCommentDto(
  comment: CommentWithAuthor,
  viewerId: string,
  viewerOwnsTrip: boolean,
  likedIds: ReadonlySet<string>,
): CommentDto {
  return {
    id: comment.id,
    markerId: comment.markerId,
    body: comment.body,
    author: toUserSummary(comment.author),
    likeCount: comment.likeCount,
    likedByMe: likedIds.has(comment.id),
    canDelete: viewerOwnsTrip || comment.authorId === viewerId,
    createdAt: comment.createdAt.toISOString(),
  };
}
