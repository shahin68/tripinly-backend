import type { LikeTargetType, Prisma } from '../../generated/prisma/client';

type LikeReader = { like: Prisma.TransactionClient['like'] };

export interface LikeTargets {
  type: LikeTargetType;
  ids: string[];
}

/**
 * Which of the given targets `userId` has liked, as one set of target ids
 * (ids are UUIDs, so targets of different types don't collide). Used to fill
 * `likedByMe` on trips, markers, photos, comments and places.
 */
export async function likedAmong(
  db: LikeReader,
  userId: string,
  ...targets: LikeTargets[]
): Promise<Set<string>> {
  const wanted = targets.filter((target) => target.ids.length > 0);
  if (wanted.length === 0) return new Set();
  const rows = await db.like.findMany({
    where: {
      userId,
      OR: wanted.map((target) => ({
        targetType: target.type,
        targetId: { in: [...new Set(target.ids)] },
      })),
    },
    select: { targetId: true },
  });
  return new Set(rows.map((row) => row.targetId));
}
