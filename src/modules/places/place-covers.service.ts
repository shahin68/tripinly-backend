import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../common/config/env';
import { PrismaService } from '../../common/prisma/prisma.service';
import { StorageService } from '../../common/storage/storage.service';
import { Prisma } from '../../generated/prisma/client';
import { thumbUrl } from '../photos/photo-keys';
import { placeImageThumbUrl } from './place-image-keys';

/** A place's image: one of its photos (`trip`) or a Commons image. */
export interface PlaceCover {
  id: string;
  source: 'trip' | 'commons';
  thumbUrl: string | null;
}

/** The best photo first: the most likes, then the newest. */
export const BEST_PHOTO_FIRST = Prisma.sql`q.likes DESC, q."createdAt" DESC, q.id`;

/**
 * Which photos may represent a place, and its image: on its map pin and card,
 * and on the pin of a stop there without a picked cover. Its own service so
 * trips can use it without the places module.
 */
@Injectable()
export class PlaceCoversService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /**
   * Each place's image for this viewer, by place id: its photo with the most
   * likes that may represent it (see `representativePhotos`), else its most
   * liked ready Commons image (the first in Commons order on a tie). Places
   * without one are left out.
   */
  async coversOf(
    userId: string,
    placeIds: string[],
  ): Promise<Map<string, PlaceCover>> {
    const ids = [...new Set(placeIds)];
    if (ids.length === 0) return new Map();
    const [photos, commons] = await Promise.all([
      this.prisma.$queryRaw<{ placeId: string; photoId: string }[]>`
        SELECT DISTINCT ON (q."placeId") q."placeId" AS "placeId", q.id AS "photoId"
        FROM (${this.representativePhotos(userId, ids)}) q
        ORDER BY q."placeId", ${BEST_PHOTO_FIRST}`,
      this.prisma.$queryRaw<{ placeId: string; imageId: string }[]>`
        SELECT DISTINCT ON ("placeId") "placeId", id AS "imageId"
        FROM place_images
        WHERE "placeId" = ANY(${ids}::uuid[]) AND status = 'ready'
        ORDER BY "placeId", "likeCount" DESC, rank, id`,
    ]);
    const covers = new Map<string, PlaceCover>();
    for (const row of commons) {
      covers.set(row.placeId, {
        id: row.imageId,
        source: 'commons',
        thumbUrl: placeImageThumbUrl(this.storage, row.imageId),
      });
    }
    for (const row of photos) {
      covers.set(row.placeId, {
        id: row.photoId,
        source: 'trip',
        thumbUrl: thumbUrl(this.storage, row.photoId),
      });
    }
    return covers;
  }

  /**
   * Ids of the photos that may represent the place (see `representativePhotos`),
   * so its gallery can show the liked public trip photos taken there too.
   */
  async representativePhotoIds(
    userId: string,
    placeId: string,
  ): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT q.id FROM (${this.representativePhotos(userId, [placeId])}) q`;
    return rows.map((row) => row.id);
  }

  /**
   * Ready photos that may represent one of [placeIds] (its cover, so its map
   * pin, and the detail photos): the place's own photos and photos on stops
   * there in public trips, liked by at least APP_PLACE_PHOTO_PIN_MIN_LIKES
   * people other than the uploader (the trip's owner and members count). Hidden
   * content and suspended uploaders or trip owners are left out. A block with
   * the viewer leaves out trip photos, never place photos (the pin names no
   * one). Columns: id, placeId, likes, createdAt.
   */
  representativePhotos(userId: string, placeIds: string[]): Prisma.Sql {
    const minLikes = this.config.get('APP_PLACE_PHOTO_PIN_MIN_LIKES', {
      infer: true,
    });
    const likes = Prisma.sql`(
      SELECT count(*)::int FROM likes l
      WHERE l."targetType" = 'photo' AND l."targetId" = ph.id AND l."userId" <> ph."uploaderId")`;
    const ready = Prisma.sql`ph.status = 'ready' AND ph."hiddenAt" IS NULL
      AND ph."likeCount" >= ${minLikes} AND ${ownerActive(Prisma.sql`ph."uploaderId"`)}`;
    return Prisma.sql`
      SELECT id, "placeId", likes, "createdAt" FROM (
        SELECT ph.id, ph."placeId", ${likes} AS likes, ph."createdAt"
        FROM photos ph
        WHERE ph."placeId" = ANY(${placeIds}::uuid[]) AND ${ready}
        UNION ALL
        SELECT ph.id, m."placeId", ${likes} AS likes, ph."createdAt"
        FROM photos ph
        JOIN markers m ON m.id = ph."markerId"
        JOIN trips t ON t.id = m."tripId"
        WHERE m."placeId" = ANY(${placeIds}::uuid[]) AND ${ready}
          AND m."hiddenAt" IS NULL AND t.visibility = 'public' AND t."hiddenAt" IS NULL
          AND ${ownerActive(Prisma.sql`t."ownerId"`)}
          AND ${notBlockedWith(userId, Prisma.sql`ph."uploaderId"`)}
          AND ${notBlockedWith(userId, Prisma.sql`t."ownerId"`)}
      ) photo
      WHERE likes >= ${minLikes}`;
  }
}

/** No block between `userId` and the user in `column`, in either direction. */
function notBlockedWith(userId: string, column: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`NOT EXISTS (
    SELECT 1 FROM blocks b
    WHERE (b."blockerId" = ${userId}::uuid AND b."blockedId" = ${column})
       OR (b."blockedId" = ${userId}::uuid AND b."blockerId" = ${column}))`;
}

/** Suspended (or deleting) users' public content leaves discovery. */
function ownerActive(ownerId: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`EXISTS (SELECT 1 FROM users u WHERE u.id = ${ownerId} AND u.status = 'active')`;
}
