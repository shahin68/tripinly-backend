import type { PrismaService } from '../../common/prisma/prisma.service';

/**
 * Closes open reports whose target is gone: the user themselves, or trips,
 * markers, photos and comments that no longer exist.
 */
export async function closeReportsOnMissingTargets(
  prisma: PrismaService,
  userId?: string,
): Promise<number> {
  return prisma.$executeRaw`
    UPDATE reports r SET status = 'dismissed', action = 'target_deleted', "reviewedAt" = now()
    WHERE r.status = 'open' AND (
      (r."targetType" = 'user' AND ${userId ?? null}::uuid IS NOT NULL AND r."targetId" = ${userId ?? null}::uuid)
      OR (r."targetType" = 'trip' AND NOT EXISTS (SELECT 1 FROM trips x WHERE x.id = r."targetId"))
      OR (r."targetType" = 'marker' AND NOT EXISTS (SELECT 1 FROM markers x WHERE x.id = r."targetId"))
      OR (r."targetType" = 'photo' AND NOT EXISTS (SELECT 1 FROM photos x WHERE x.id = r."targetId"))
      OR (r."targetType" = 'comment' AND NOT EXISTS (SELECT 1 FROM comments x WHERE x.id = r."targetId"))
    )`;
}

export interface TargetRef {
  targetType: 'user' | 'trip' | 'marker' | 'photo' | 'comment';
  targetId: string;
}

export interface TargetInfo {
  exists: boolean;
  ownerId: string | null;
  text: string | null;
  photoId: string | null;
  tripId: string | null;
  hidden: boolean;
}

export const targetKey = (ref: TargetRef) =>
  `${ref.targetType}:${ref.targetId}`;

const MISSING: TargetInfo = {
  exists: false,
  ownerId: null,
  text: null,
  photoId: null,
  tripId: null,
  hidden: false,
};

/** What each reported thing is and who is behind it, in one query per type. */
export async function describeTargets(
  prisma: PrismaService,
  refs: TargetRef[],
): Promise<Map<string, TargetInfo>> {
  const ids = (type: TargetRef['targetType']) => [
    ...new Set(
      refs.filter((r) => r.targetType === type).map((r) => r.targetId),
    ),
  ];
  const [users, trips, markers, photos, comments] = await Promise.all([
    prisma.user.findMany({
      where: { id: { in: ids('user') } },
      select: { id: true, displayName: true, status: true },
    }),
    prisma.trip.findMany({
      where: { id: { in: ids('trip') } },
      select: { id: true, title: true, ownerId: true, hiddenAt: true },
    }),
    prisma.marker.findMany({
      where: { id: { in: ids('marker') } },
      select: {
        id: true,
        name: true,
        createdById: true,
        tripId: true,
        hiddenAt: true,
      },
    }),
    prisma.photo.findMany({
      where: { id: { in: ids('photo') } },
      select: { id: true, uploaderId: true, tripId: true, hiddenAt: true },
    }),
    prisma.comment.findMany({
      where: { id: { in: ids('comment') } },
      select: {
        id: true,
        body: true,
        authorId: true,
        tripId: true,
        hiddenAt: true,
      },
    }),
  ]);
  const result = new Map<string, TargetInfo>();
  for (const ref of refs) result.set(targetKey(ref), MISSING);
  const put = (
    type: TargetRef['targetType'],
    id: string,
    info: Omit<TargetInfo, 'exists'>,
  ) =>
    result.set(targetKey({ targetType: type, targetId: id }), {
      exists: true,
      ...info,
    });
  for (const u of users) {
    put('user', u.id, {
      ownerId: u.id,
      text: u.displayName,
      photoId: null,
      tripId: null,
      hidden: u.status !== 'active',
    });
  }
  for (const t of trips) {
    put('trip', t.id, {
      ownerId: t.ownerId,
      text: t.title,
      photoId: null,
      tripId: t.id,
      hidden: t.hiddenAt !== null,
    });
  }
  for (const m of markers) {
    put('marker', m.id, {
      ownerId: m.createdById,
      text: m.name,
      photoId: null,
      tripId: m.tripId,
      hidden: m.hiddenAt !== null,
    });
  }
  for (const p of photos) {
    put('photo', p.id, {
      ownerId: p.uploaderId,
      text: null,
      photoId: p.id,
      tripId: p.tripId,
      hidden: p.hiddenAt !== null,
    });
  }
  for (const c of comments) {
    put('comment', c.id, {
      ownerId: c.authorId,
      text: c.body,
      photoId: null,
      tripId: c.tripId,
      hidden: c.hiddenAt !== null,
    });
  }
  return result;
}
