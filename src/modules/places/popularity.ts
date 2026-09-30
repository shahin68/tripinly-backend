import { Prisma } from '../../generated/prisma/client';

type Tx = Pick<Prisma.TransactionClient, '$executeRaw'>;

/**
 * A place's popularity from its source rows: likes on its markers in public,
 * visible trips (hidden markers left out) plus direct likes on the place.
 */
const POPULARITY_OF = (placeId: Prisma.Sql) => Prisma.sql`
  COALESCE((
    SELECT sum(m."likeCount") FROM markers m JOIN trips t ON t.id = m."tripId"
    WHERE m."placeId" = ${placeId} AND m."hiddenAt" IS NULL
      AND t.visibility = 'public' AND t."hiddenAt" IS NULL
  ), 0) + (
    SELECT count(*) FROM likes l WHERE l."targetType" = 'place' AND l."targetId" = ${placeId}
  )`;

/**
 * Recomputes `places.popularity` for the given places. Call it in the same
 * transaction as any change that moves marker likes in or out of the count:
 * a like on a marker or place, a trip's visibility change, deleting a trip,
 * day or marker, moving a marker to another place.
 */
export async function recomputePopularity(
  tx: Tx,
  placeIds: Iterable<string>,
): Promise<void> {
  const ids = [...new Set(placeIds)];
  if (ids.length === 0) return;
  await tx.$executeRaw`
    UPDATE places p SET popularity = c.popularity
    FROM (
      SELECT id, (${POPULARITY_OF(Prisma.sql`target.id`)})::int AS popularity
      FROM unnest(${ids}::uuid[]) AS target(id)
    ) c
    WHERE p.id = c.id AND p.popularity <> c.popularity`;
}

/** Nightly: fixes any drift in every place that has or had popularity. */
export async function recomputeAllPopularity(tx: Tx): Promise<number> {
  return tx.$executeRaw`
    UPDATE places p SET popularity = c.popularity
    FROM (
      SELECT id, (${POPULARITY_OF(Prisma.sql`candidate.id`)})::int AS popularity
      FROM (
        SELECT id FROM places WHERE popularity > 0
        UNION SELECT DISTINCT "placeId" FROM markers WHERE "likeCount" > 0
        UNION SELECT DISTINCT "targetId" FROM likes WHERE "targetType" = 'place'
      ) candidate
    ) c
    WHERE p.id = c.id AND p.popularity <> c.popularity`;
}
