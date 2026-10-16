import type { PrismaService } from '../../common/prisma/prisma.service';
import type { PhotoJobsService } from '../photos/photos.queue';

/**
 * A user-made place lives while any stop uses it (B6): when the last one goes,
 * the place goes with its place photos, likes and files. OSM places stay.
 * Call after the transaction that removed or moved stops at these places has
 * committed; places still in use are left alone.
 */
export async function releaseUserPlaces(
  prisma: PrismaService,
  photoJobs: PhotoJobsService,
  placeIds: Iterable<string>,
): Promise<void> {
  for (const placeId of new Set(placeIds)) {
    const photoIds = await prisma.$transaction(async (tx) => {
      // Serializes with new stops (their foreign key) and place photo uploads.
      const [place] = await tx.$queryRaw<{ source: string }[]>`
        SELECT source FROM places WHERE id = ${placeId}::uuid FOR UPDATE`;
      if (place?.source !== 'user') return [];
      const inUse = await tx.marker.findFirst({
        where: { placeId },
        select: { id: true },
      });
      if (inUse) return [];
      const photos = await tx.photo.findMany({
        where: { placeId },
        select: { id: true },
      });
      // Photos cascade; the likes trigger removes likes on the place and its photos.
      await tx.place.delete({ where: { id: placeId } });
      return photos.map((photo) => photo.id);
    });
    await photoJobs.deleteFiles(photoIds);
  }
}
