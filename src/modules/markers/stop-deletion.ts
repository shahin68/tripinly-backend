import { HttpStatus } from '@nestjs/common';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import type { Prisma } from '../../generated/prisma/client';

type Tx = Pick<Prisma.TransactionClient, '$queryRaw'>;

export interface OthersContent {
  photos: number;
  comments: number;
  likes: number;
}

/**
 * Who may delete a stop with everything on it (B4, B5): whoever added it,
 * and the trip owner. Everyone else may only remove their own photos,
 * comments and likes from it.
 */
export function mayDeleteStop(
  userId: string,
  tripOwnerId: string,
  stop: { createdById: string | null },
): boolean {
  return userId === tripOwnerId || stop.createdById === userId;
}

/** Photos, comments and likes by anyone but `userId` on these stops (and on their photos and comments). */
export async function othersContent(
  tx: Tx,
  markerIds: string[],
  userId: string,
): Promise<OthersContent> {
  if (markerIds.length === 0) return { photos: 0, comments: 0, likes: 0 };
  const [row] = await tx.$queryRaw<OthersContent[]>`
    SELECT
      (SELECT count(*) FROM photos p
        WHERE p."markerId" = ANY(${markerIds}::uuid[]) AND p."uploaderId" <> ${userId}::uuid)::int AS photos,
      (SELECT count(*) FROM comments c
        WHERE c."markerId" = ANY(${markerIds}::uuid[]) AND c."authorId" <> ${userId}::uuid)::int AS comments,
      (SELECT count(*) FROM likes l
        WHERE l."userId" <> ${userId}::uuid AND (
          (l."targetType" = 'marker' AND l."targetId" = ANY(${markerIds}::uuid[]))
          OR (l."targetType" = 'photo' AND l."targetId" IN (
            SELECT id FROM photos WHERE "markerId" = ANY(${markerIds}::uuid[])))
          OR (l."targetType" = 'comment' AND l."targetId" IN (
            SELECT id FROM comments WHERE "markerId" = ANY(${markerIds}::uuid[])))
        ))::int AS likes`;
  return row;
}

/**
 * Deleting stops that carry other people's content needs `confirm` (the app
 * shows a warning first): 409 STOP_HAS_OTHERS_CONTENT with the counts.
 */
export async function assertConfirmedIfShared(
  tx: Tx,
  markerIds: string[],
  userId: string,
  confirm: boolean,
): Promise<void> {
  if (confirm) return;
  const others = await othersContent(tx, markerIds, userId);
  if (others.photos + others.comments + others.likes > 0) {
    throw new AppException(
      ErrorCode.STOP_HAS_OTHERS_CONTENT,
      HttpStatus.CONFLICT,
      { ...others },
    );
  }
}
