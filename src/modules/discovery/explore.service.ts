import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/errors/app.exception';
import {
  DEFAULT_PAGE_SIZE,
  type Page,
} from '../../common/pagination/pagination';
import { PrismaService } from '../../common/prisma/prisma.service';
import { StorageService } from '../../common/storage/storage.service';
import { Prisma } from '../../generated/prisma/client';
import { toTripSummaries, tripSummaryInclude } from '../trips/trip.mapper';
import type { TripSummaryDto } from '../trips/trips.dto';

/** Where a page of Explore ends. `ref` fixes "now" for the whole scroll so scores don't shift between pages. */
interface ExploreCursor {
  ref: string;
  score: number;
  createdAt: string;
  id: string;
}

/**
 * Explore: public, visible trips of other people with at least one marker,
 * owner without a block with the viewer. Ranked by
 * (likes + 2 × copies) / (age in days + 2)^1.5, newest first on ties.
 */
@Injectable()
export class ExploreService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  async trips(
    userId: string,
    cursor?: string,
    limit = DEFAULT_PAGE_SIZE,
  ): Promise<Page<TripSummaryDto>> {
    const after = cursor ? decodeExploreCursor(cursor) : null;
    const ref = after ? new Date(after.ref) : new Date();
    const ranked = await this.prisma.$queryRaw<
      { id: string; score: number; createdAt: Date }[]
    >`
      SELECT id, score, "createdAt" FROM (
        SELECT t.id, t."createdAt",
               (t."likeCount" + 2 * t."copyCount")::float8
                 / power(greatest(extract(epoch FROM (${ref.toISOString()}::timestamp - t."createdAt")) / 86400.0, 0) + 2, 1.5)
                 AS score
        FROM trips t
        WHERE t.visibility = 'public' AND t."hiddenAt" IS NULL
          AND t."ownerId" <> ${userId}::uuid
          -- Suspended (or deleting) owners' trips leave discovery.
          AND EXISTS (SELECT 1 FROM users u WHERE u.id = t."ownerId" AND u.status = 'active')
          AND EXISTS (SELECT 1 FROM markers m WHERE m."tripId" = t.id AND m."hiddenAt" IS NULL)
          AND NOT EXISTS (
            SELECT 1 FROM blocks b
            WHERE (b."blockerId" = ${userId}::uuid AND b."blockedId" = t."ownerId")
               OR (b."blockedId" = ${userId}::uuid AND b."blockerId" = t."ownerId"))
      ) ranked
      WHERE ${
        after
          ? Prisma.sql`(score, "createdAt", id) < (${after.score}::float8, ${after.createdAt}::timestamp, ${after.id}::uuid)`
          : Prisma.sql`true`
      }
      ORDER BY score DESC, "createdAt" DESC, id DESC
      LIMIT ${limit + 1}`;

    const kept = ranked.slice(0, limit);
    const rows = await this.prisma.trip.findMany({
      where: { id: { in: kept.map((row) => row.id) } },
      include: tripSummaryInclude(userId),
    });
    const dtos = await toTripSummaries(this.prisma, this.storage, userId, rows);
    const byId = new Map(dtos.map((dto) => [dto.id, dto]));
    const last = kept[kept.length - 1];
    return {
      items: kept.flatMap((row) => byId.get(row.id) ?? []),
      nextCursor:
        ranked.length > limit
          ? encodeExploreCursor({
              ref: ref.toISOString(),
              score: last.score,
              createdAt: last.createdAt.toISOString(),
              id: last.id,
            })
          : null,
    };
  }
}

function encodeExploreCursor(cursor: ExploreCursor): string {
  return Buffer.from(
    JSON.stringify([cursor.ref, cursor.score, cursor.createdAt, cursor.id]),
  ).toString('base64url');
}

function decodeExploreCursor(value: string): ExploreCursor {
  try {
    const [ref, score, createdAt, id] = JSON.parse(
      Buffer.from(value, 'base64url').toString(),
    ) as unknown[];
    if (
      typeof ref === 'string' &&
      !Number.isNaN(Date.parse(ref)) &&
      typeof score === 'number' &&
      Number.isFinite(score) &&
      typeof createdAt === 'string' &&
      !Number.isNaN(Date.parse(createdAt)) &&
      typeof id === 'string' &&
      /^[0-9a-f-]{36}$/i.test(id)
    ) {
      return { ref, score, createdAt, id };
    }
  } catch {
    // fall through
  }
  throw AppException.validation({ cursor: ['invalidCursor'] });
}
