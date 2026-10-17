import { Prisma } from '../../generated/prisma/client';

type Tx = Pick<Prisma.TransactionClient, '$executeRaw'>;

/** A stop that makes its user-made place public: visible, on a public, visible trip. */
export const PUBLIC_STOP_WHERE = {
  hiddenAt: null,
  trip: { visibility: 'public', hiddenAt: null },
} satisfies Prisma.MarkerWhereInput;

/**
 * A place's popularity is its likes (E1). A user-made place counts them only
 * while a visible stop of a public, visible trip is on it, so a custom spot
 * that is only in private trips stays out of every public list.
 */
const POPULARITY_OF = (placeId: Prisma.Sql) => Prisma.sql`
  CASE WHEN EXISTS (SELECT 1 FROM places p WHERE p.id = ${placeId} AND p.source = 'osm')
    OR EXISTS (
      SELECT 1 FROM markers m JOIN trips t ON t.id = m."tripId"
      WHERE m."placeId" = ${placeId} AND m."hiddenAt" IS NULL
        AND t.visibility = 'public' AND t."hiddenAt" IS NULL)
  THEN (SELECT count(*) FROM likes l WHERE l."targetType" = 'place' AND l."targetId" = ${placeId})
  ELSE 0 END`;

/**
 * Recomputes `places.popularity` for the given places. Call it in the same
 * transaction as any change that can move it: a like on a place, and, for
 * user-made places, a trip's visibility change, hiding a trip or stop, and
 * creating, copying, moving or deleting stops (with their days and trips).
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
        UNION SELECT DISTINCT "targetId" FROM likes WHERE "targetType" = 'place'
      ) candidate
    ) c
    WHERE p.id = c.id AND p.popularity <> c.popularity`;
}
