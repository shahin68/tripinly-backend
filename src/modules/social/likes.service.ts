import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { domainEvent, DomainEvents } from '../../common/events/domain-events';
import { AppException } from '../../common/errors/app.exception';
import { PrismaService } from '../../common/prisma/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import { BlocksService } from '../moderation/blocks.service';
import { PlaceMatchingService } from '../places/place-matching.service';
import { recomputePopularity } from '../places/popularity';
import { TripAccessService } from '../trips/trip-access.service';
import type {
  HotStateDto,
  LikeStateDto,
  LikeTargetTypeValue,
  StoredLikeType,
} from './social.dto';

type Tx = Prisma.TransactionClient;

/** Tables that carry a likeCount, by target type. Constants only: used as SQL identifiers. */
const COUNTED_TABLES = {
  trip: 'trips',
  photo: 'photos',
  comment: 'comments',
  place_image: 'place_images',
} as const satisfies Partial<Record<LikeTargetTypeValue, string>>;

interface ResolvedTarget {
  /** The trip whose room hears about the change; null for places. */
  tripId: string | null;
  /** The place whose popularity this like moves, if any. */
  placeId: string | null;
}

/**
 * Likes on trips, photos, comments and places' Commons images, and hot marks on
 * places, stored as likes of type `place`; a stop's flame marks its place (E1).
 * One like per user and target; liking twice or unliking twice
 * changes nothing. Counters move in the same transaction, with the target row
 * locked so a like can't land on a target that is being deleted (its likes are
 * removed by a trigger).
 */
@Injectable()
export class LikesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TripAccessService,
    private readonly blocks: BlocksService,
    private readonly places: PlaceMatchingService,
    private readonly events: EventEmitter2,
  ) {}

  like(
    userId: string,
    targetType: LikeTargetTypeValue,
    targetId: string,
  ): Promise<LikeStateDto> {
    return this.likeState(userId, targetType, targetId, true);
  }

  unlike(
    userId: string,
    targetType: LikeTargetTypeValue,
    targetId: string,
  ): Promise<LikeStateDto> {
    return this.likeState(userId, targetType, targetId, false);
  }

  /** Marks (or, with `hot` false, unmarks) a place hot. */
  async markHot(
    userId: string,
    placeId: string,
    hot: boolean,
  ): Promise<HotStateDto> {
    const count = await this.change(userId, 'place', placeId, hot);
    return { placeId, hot, hotCount: count };
  }

  private async likeState(
    userId: string,
    targetType: LikeTargetTypeValue,
    targetId: string,
    liked: boolean,
  ): Promise<LikeStateDto> {
    const likeCount = await this.change(userId, targetType, targetId, liked);
    return { targetType, targetId, liked, likeCount };
  }

  /** Stores or removes the like and returns the target's new count. */
  private async change(
    userId: string,
    targetType: StoredLikeType,
    targetId: string,
    liked: boolean,
  ): Promise<number> {
    const target = await this.resolve(userId, targetType, targetId);

    const { changed, likeCount } = await this.prisma.$transaction(
      async (tx) => {
        await lockTarget(tx, targetType, targetId);
        let changed: boolean;
        if (liked) {
          const inserted = await tx.like.createMany({
            data: [{ userId, targetType, targetId }],
            skipDuplicates: true,
          });
          changed = inserted.count > 0;
        } else {
          const deleted = await tx.like.deleteMany({
            where: { userId, targetType, targetId },
          });
          changed = deleted.count > 0;
        }
        if (changed && targetType !== 'place') {
          await moveCount(tx, targetType, targetId, liked ? 1 : -1);
        }
        if (changed && target.placeId) {
          await recomputePopularity(tx, [target.placeId]);
        }
        return {
          changed,
          likeCount: await readCount(tx, targetType, targetId),
        };
      },
    );

    if (changed && targetType === 'place') {
      this.events.emit(
        DomainEvents.PLACE_HOT_CHANGED,
        domainEvent(DomainEvents.PLACE_HOT_CHANGED, userId, {
          placeId: targetId,
          hotCount: likeCount,
        }),
      );
    } else if (changed) {
      this.events.emit(
        DomainEvents.LIKE_COUNT_CHANGED,
        domainEvent(
          DomainEvents.LIKE_COUNT_CHANGED,
          userId,
          { targetType, targetId, count: likeCount, liked },
          target.tripId ?? undefined,
        ),
      );
    }
    return likeCount;
  }

  /**
   * Checks the caller may like (or unlike) the target: they can see it, it
   * isn't hidden, and there's no block with whoever posted it.
   */
  private async resolve(
    userId: string,
    targetType: StoredLikeType,
    targetId: string,
  ): Promise<ResolvedTarget> {
    switch (targetType) {
      case 'trip': {
        await this.access.assert(userId, targetId, 'like');
        return { tripId: targetId, placeId: null };
      }
      case 'photo': {
        const photo = await this.prisma.photo.findUnique({
          where: { id: targetId },
          select: {
            markerId: true,
            placeId: true,
            status: true,
            hiddenAt: true,
            uploaderId: true,
          },
        });
        // A profile photo (no stop, no place) has no likes.
        if (!photo || (!photo.markerId && !photo.placeId)) {
          throw AppException.notFound();
        }
        if (!photo.markerId) {
          // A place photo: whoever can see the place, not blocked with the uploader (C7).
          await this.places.assertVisible(this.prisma, userId, photo.placeId!);
          await this.assertShown(userId, photo.uploaderId, photo.hiddenAt);
          if (photo.status !== 'ready') throw AppException.notFound();
          return { tripId: null, placeId: null };
        }
        const { trip } = await this.access.assertForMarker(
          userId,
          photo.markerId,
          'like',
        );
        await this.assertShown(userId, photo.uploaderId, photo.hiddenAt);
        if (photo.status !== 'ready') throw AppException.notFound();
        return { tripId: trip.id, placeId: null };
      }
      case 'comment': {
        const comment = await this.prisma.comment.findUnique({
          where: { id: targetId },
          select: { markerId: true, hiddenAt: true, authorId: true },
        });
        if (!comment) throw AppException.notFound();
        const { trip } = await this.access.assertForMarker(
          userId,
          comment.markerId,
          'like',
        );
        await this.assertShown(userId, comment.authorId, comment.hiddenAt);
        return { tripId: trip.id, placeId: null };
      }
      case 'place': {
        const place = await this.prisma.place.findUnique({
          where: { id: targetId },
          select: { id: true, source: true, popularity: true },
        });
        if (
          !place ||
          !(await this.places.isLikeable(this.prisma, userId, place))
        ) {
          throw AppException.notFound();
        }
        return { tripId: null, placeId: place.id };
      }
      case 'place_image': {
        // A Commons image: whoever can see its place, while it is shown.
        const image = await this.prisma.placeImage.findUnique({
          where: { id: targetId },
          select: { placeId: true, status: true },
        });
        if (!image || image.status !== 'ready') throw AppException.notFound();
        await this.places.assertVisible(this.prisma, userId, image.placeId);
        return { tripId: null, placeId: null };
      }
    }
  }

  /** Content hidden by moderation or posted by someone with a block with the caller reads as missing. */
  private async assertShown(
    userId: string,
    authorId: string,
    hiddenAt: Date | null,
  ): Promise<void> {
    if (authorId === userId) return;
    if (hiddenAt || (await this.blocks.isBlockedEither(userId, authorId))) {
      throw AppException.notFound();
    }
  }
}

async function lockTarget(
  tx: Tx,
  targetType: StoredLikeType,
  targetId: string,
): Promise<void> {
  const table = targetType === 'place' ? 'places' : COUNTED_TABLES[targetType];
  const rows = await tx.$queryRaw<unknown[]>`
    SELECT 1 FROM ${Prisma.raw(table)} WHERE id = ${targetId}::uuid FOR UPDATE`;
  if (rows.length === 0) throw AppException.notFound();
}

async function moveCount(
  tx: Tx,
  targetType: keyof typeof COUNTED_TABLES,
  targetId: string,
  delta: 1 | -1,
): Promise<void> {
  await tx.$executeRaw`
    UPDATE ${Prisma.raw(COUNTED_TABLES[targetType])}
    SET "likeCount" = greatest(0, "likeCount" + ${delta})
    WHERE id = ${targetId}::uuid`;
}

async function readCount(
  tx: Tx,
  targetType: StoredLikeType,
  targetId: string,
): Promise<number> {
  const [row] =
    targetType === 'place'
      ? await tx.$queryRaw<{ count: number }[]>`
          SELECT popularity AS count FROM places WHERE id = ${targetId}::uuid`
      : await tx.$queryRaw<{ count: number }[]>`
          SELECT "likeCount" AS count FROM ${Prisma.raw(COUNTED_TABLES[targetType])}
          WHERE id = ${targetId}::uuid`;
  return row?.count ?? 0;
}
