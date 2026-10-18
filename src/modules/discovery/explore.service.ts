import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../common/config/env';
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
import type { ExplorePeriod } from './explore.dto';

/** Filters on Explore; [near] is used for this query only, never stored or logged. */
export interface ExploreFilter {
  includeMine: boolean;
  period: ExplorePeriod;
  near?: { lat: number; lng: number };
}

/** How far back each period reaches: only trips created since then show. */
const PERIOD_DAYS: Partial<Record<ExplorePeriod, number>> = {
  week: 7,
  month: 30,
  year: 365,
};

/** Where a page of Explore ends. `ref` fixes "now" for the whole scroll so scores don't shift between pages. */
interface ExploreCursor {
  ref: string;
  score: number;
  createdAt: string;
  id: string;
}

/**
 * Explore: public, visible trips with at least one marker, the viewer's own
 * included (Shahin 2026-10-16: a popular trip shows to its owner too; `role`
 * tells the app not to offer Save; `includeMine` false leaves them out), owner without a block with the viewer.
 * Ranked by likes only (saves never count, Shahin 2026-10-16), newest first on ties. `week`,
 * `month` and `year` keep the trips created in the last 7, 30 or 365 days (Shahin 2026-10-18);
 * `season` keeps trips travelled in the current season; `all` keeps every trip. `near` keeps trips with a stop within
 * `APP_EXPLORE_NEARBY_RADIUS_KM`.
 */
@Injectable()
export class ExploreService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async trips(
    userId: string,
    filter: ExploreFilter,
    cursor?: string,
    limit = DEFAULT_PAGE_SIZE,
  ): Promise<Page<TripSummaryDto>> {
    const after = cursor ? decodeExploreCursor(cursor) : null;
    const ref = after ? new Date(after.ref) : new Date();
    const days = PERIOD_DAYS[filter.period];
    // Week, month and year keep the trips created in that window (Shahin 2026-10-18), ranked by their likes.
    const createdSince =
      days === undefined
        ? Prisma.sql`true`
        : Prisma.sql`t."createdAt" > ${ref.toISOString()}::timestamp - make_interval(days => ${days}::int)`;
    const season =
      filter.period === 'season'
        ? Prisma.sql`(extract(month FROM t."startDate")::int IN (${Prisma.join(seasonMonths(ref))})
            OR extract(month FROM t."endDate")::int IN (${Prisma.join(seasonMonths(ref))}))`
        : Prisma.sql`true`;
    const near = filter.near
      ? Prisma.sql`EXISTS (
          SELECT 1 FROM markers nm WHERE nm."tripId" = t.id AND nm."hiddenAt" IS NULL
            AND ST_DWithin(nm.location,
              ST_SetSRID(ST_MakePoint(${filter.near.lng}, ${filter.near.lat}), 4326)::geography,
              ${this.config.get('APP_EXPLORE_NEARBY_RADIUS_KM', { infer: true }) * 1000}))`
      : Prisma.sql`true`;
    const ranked = await this.prisma.$queryRaw<
      { id: string; score: number; createdAt: Date }[]
    >`
      SELECT id, score, "createdAt" FROM (
        SELECT t.id, t."createdAt",
               t."likeCount"::float8 AS score
        FROM trips t
        WHERE t.visibility = 'public' AND t."hiddenAt" IS NULL
          -- Suspended (or deleting) owners' trips leave discovery.
          AND EXISTS (SELECT 1 FROM users u WHERE u.id = t."ownerId" AND u.status = 'active')
          AND EXISTS (SELECT 1 FROM markers m WHERE m."tripId" = t.id AND m."hiddenAt" IS NULL)
          AND ${createdSince}
          AND ${season}
          AND ${near}
          AND ${
            filter.includeMine
              ? Prisma.sql`true`
              : Prisma.sql`t."ownerId" <> ${userId}::uuid AND NOT EXISTS (
                  SELECT 1 FROM trip_members tm WHERE tm."tripId" = t.id AND tm."userId" = ${userId}::uuid)`
          }
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

/** The months of the season [ref] is in (meteorological, northern hemisphere: fall is September to November). */
function seasonMonths(ref: Date): number[] {
  const month = ref.getUTCMonth() + 1;
  const first = month - (month % 3);
  return [first, first + 1, first + 2].map((m) => ((m + 11) % 12) + 1);
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
