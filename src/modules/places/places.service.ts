import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { AppException } from '../../common/errors/app.exception';
import { PrismaService } from '../../common/prisma/prisma.service';
import { REDIS } from '../../common/redis/redis.module';
import { Prisma, type PlaceCategory } from '../../generated/prisma/client';
import { TripAccessService } from '../trips/trip-access.service';
import {
  assertBboxSpan,
  type Bbox,
  maxSpanForZoom,
  OSM_FILL_MIN_ZOOM,
  parseBbox,
  snapBbox,
} from './bbox';
import { normalizePlaceName } from './normalize-name';
import { PhotonClient } from './photon.client';
import { PlaceMatchingService } from './place-matching.service';
import {
  IN_VIEW_CACHE_TTL_SECONDS,
  IN_VIEW_CACHE_VERSION_KEY,
} from './places-cache';
import {
  type InViewQueryDto,
  type InViewResponseDto,
  type NearbyPageDto,
  type NearbyPlaceDto,
  type NearbyQueryDto,
  OSM_ATTRIBUTION,
  type PlaceClusterDto,
  type PlaceDetailDto,
  type PlaceItemDto,
  type PopularQueryDto,
  type PopularResponseDto,
  type SearchQueryDto,
  type SearchResponseDto,
  type SearchResultDto,
} from './places.dto';

const DEFAULT_IN_VIEW_LIMIT = 100;
/** OSM fill is spread over a GRID × GRID split of the bbox. */
const OSM_FILL_GRID = 6;
const MAX_CLUSTER_GRID = 8;
/** Popular spots have no zoom; this keeps the query to a region. */
const POPULAR_MAX_SPAN_DEGREES = 5;
const DEFAULT_RADIUS_KM = 5;
const NEARBY_TOP_UP_BELOW = 10;
const SEARCH_LIMIT = 10;
/** Sights that top up Nearby; cafés and bars are too many to be useful there. */
const SIGHT_CATEGORIES: PlaceCategory[] = [
  'attraction',
  'museum',
  'historic',
  'landmark',
];

interface PlaceRow {
  id: string;
  name: string;
  names: Prisma.JsonValue;
  category: PlaceCategory;
  lat: number;
  lng: number;
  popularity: number;
}

/** Columns every place list selects (PlaceRow). */
const PLACE_COLUMNS = Prisma.sql`p.id, p.name, p.names, p.category, p.lat, p.lng, p.popularity`;

/**
 * Map, search and discovery reads over our places (geo-discovery skill).
 * Only OSM places and places liked on public trips (popularity > 0) are ever
 * listed: a user place from a private trip must not surface. Coordinates from
 * the caller are used for the query only.
 */
@Injectable()
export class PlacesService {
  private readonly logger = new Logger(PlacesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TripAccessService,
    private readonly photon: PhotonClient,
    private readonly matching: PlaceMatchingService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async inView(
    query: InViewQueryDto,
    lang: string,
  ): Promise<InViewResponseDto> {
    const requested = parseBbox(query.bbox);
    assertBboxSpan(requested, maxSpanForZoom(query.zoom));
    const zoom = Math.floor(query.zoom);
    const bbox = snapBbox(requested, zoom);
    const limit = query.limit ?? DEFAULT_IN_VIEW_LIMIT;
    const categories = query.categories?.length
      ? [...query.categories].sort()
      : undefined;

    const key = await this.inViewCacheKey(bbox, zoom, categories, limit, lang);
    const cached = key ? await this.cacheGet<InViewResponseDto>(key) : null;
    if (cached) return cached;

    const result =
      zoom >= OSM_FILL_MIN_ZOOM
        ? await this.inViewDetailed(bbox, categories, limit, lang)
        : await this.inViewOverview(bbox, categories, limit, lang);
    if (key) await this.cacheSet(key, result, IN_VIEW_CACHE_TTL_SECONDS);
    return result;
  }

  async popular(
    userId: string,
    query: PopularQueryDto,
    lang: string,
  ): Promise<PopularResponseDto> {
    const bbox = parseBbox(query.bbox);
    assertBboxSpan(bbox, POPULAR_MAX_SPAN_DEGREES);
    if (query.excludeTripId) {
      await this.access.assert(userId, query.excludeTripId, 'view');
    }
    const exclude = query.excludeTripId
      ? Prisma.sql`AND NOT EXISTS (
          SELECT 1 FROM markers m WHERE m."placeId" = p.id AND m."tripId" = ${query.excludeTripId}::uuid)`
      : Prisma.empty;
    const rows = await this.prisma.$queryRaw<PlaceRow[]>`
      SELECT ${PLACE_COLUMNS} FROM places p
      WHERE p."isActive" AND p.popularity > 0 AND ${inBbox(bbox)} ${exclude}
      ORDER BY p.popularity DESC, p.id
      LIMIT ${query.limit ?? 20}`;
    return {
      items: rows.map((row) => toPlaceItem(row, lang)),
      attribution: OSM_ATTRIBUTION,
    };
  }

  async nearby(query: NearbyQueryDto, lang: string): Promise<NearbyPageDto> {
    const limit = query.limit ?? 20;
    const radius = (query.radiusKm ?? DEFAULT_RADIUS_KM) * 1000;
    const point = Prisma.sql`ST_SetSRID(ST_MakePoint(${query.lng}, ${query.lat}), 4326)::geography`;
    const after = query.cursor ? decodeScoreCursor(query.cursor) : null;

    const rows = await this.prisma.$queryRaw<
      (PlaceRow & { distance: number; score: number })[]
    >`
      SELECT * FROM (
        SELECT ${PLACE_COLUMNS}, ST_Distance(p.location, ${point}) AS distance,
               p.popularity / power(1 + ST_Distance(p.location, ${point}) / 1000.0, 1.2) AS score
        FROM places p
        WHERE p."isActive" AND p.popularity > 0 AND ST_DWithin(p.location, ${point}, ${radius})
      ) ranked
      WHERE ${
        after
          ? Prisma.sql`(ranked.score < ${after.score} OR (ranked.score = ${after.score} AND ranked.id < ${after.id}::uuid))`
          : Prisma.sql`true`
      }
      ORDER BY ranked.score DESC, ranked.id DESC
      LIMIT ${limit + 1}`;

    const kept = rows.slice(0, limit);
    const items: NearbyPlaceDto[] = kept.map((row) => ({
      ...toPlaceItem(row, lang),
      distanceMeters: Math.round(row.distance),
    }));
    const hasMore = rows.length > limit;
    const last = kept[kept.length - 1];

    // Few liked places around: top the first page up with OSM sights by distance.
    if (!after && !hasMore && items.length < NEARBY_TOP_UP_BELOW) {
      const sights = await this.prisma.$queryRaw<
        (PlaceRow & { distance: number })[]
      >`
        SELECT ${PLACE_COLUMNS}, ST_Distance(p.location, ${point}) AS distance
        FROM places p
        WHERE p."isActive" AND p.source = 'osm' AND p.popularity = 0
          AND p.category = ANY(${SIGHT_CATEGORIES}::"PlaceCategory"[])
          AND ST_DWithin(p.location, ${point}, ${radius})
        ORDER BY p.location <-> ${point}
        LIMIT ${limit - items.length}`;
      for (const row of sights) {
        items.push({
          ...toPlaceItem(row, lang),
          distanceMeters: Math.round(row.distance),
        });
      }
    }

    return {
      items,
      nextCursor: hasMore ? encodeScoreCursor(last.score, last.id) : null,
      attribution: OSM_ATTRIBUTION,
    };
  }

  async search(
    query: SearchQueryDto,
    lang: string,
  ): Promise<SearchResponseDto> {
    const near =
      query.lat !== undefined && query.lng !== undefined
        ? { lat: query.lat, lng: query.lng }
        : undefined;
    const [ours, photon] = await Promise.all([
      this.searchOurs(normalizePlaceName(query.q), lang, near),
      this.photon.search({ q: query.q, lang, near }),
    ]);
    const known = new Set(
      ours
        .filter((item) => item.osmType)
        .map((item) => `${item.osmType}:${item.osmId}`),
    );
    const extra = photon.filter(
      (item) => !item.osmType || !known.has(`${item.osmType}:${item.osmId}`),
    );
    return { items: [...ours, ...extra], attribution: OSM_ATTRIBUTION };
  }

  /** A place by id, if the caller may see it (PlaceMatchingService.isVisible). */
  async get(
    userId: string,
    placeId: string,
    lang: string,
  ): Promise<PlaceDetailDto> {
    const place = await this.prisma.place.findUnique({
      where: { id: placeId },
      select: {
        id: true,
        name: true,
        names: true,
        category: true,
        lat: true,
        lng: true,
        popularity: true,
        source: true,
        isActive: true,
        osmType: true,
        osmId: true,
        tags: true,
      },
    });
    if (
      !place ||
      !(await this.matching.isVisible(this.prisma, userId, place))
    ) {
      throw AppException.notFound();
    }
    const tags = asStringRecord(place.tags);
    return {
      ...toPlaceItem(place, lang),
      source: place.source,
      isActive: place.isActive,
      osmType: place.osmType,
      osmId: place.osmId?.toString() ?? null,
      tags: {
        website: tags.website ?? null,
        openingHours: tags.opening_hours ?? null,
        cuisine: tags.cuisine ?? null,
        wikidata: tags.wikidata ?? null,
      },
      photoThumbUrls: [],
      attribution:
        place.source === 'osm' || place.osmId ? OSM_ATTRIBUTION : null,
    };
  }

  /** Zoom ≥ 14: Tripinly places by popularity, then OSM places spread over the view. */
  private async inViewDetailed(
    bbox: Bbox,
    categories: PlaceCategory[] | undefined,
    limit: number,
    lang: string,
  ): Promise<InViewResponseDto> {
    const tripinly = await this.prisma.$queryRaw<PlaceRow[]>`
      SELECT ${PLACE_COLUMNS} FROM places p
      WHERE p."isActive" AND p.popularity > 0 AND ${inBbox(bbox)} ${inCategories(categories)}
      ORDER BY p.popularity DESC, p.id
      LIMIT ${limit}`;
    const remaining = limit - tripinly.length;
    const osm =
      remaining > 0
        ? await this.prisma.$queryRaw<PlaceRow[]>`
          SELECT id, name, names, category, lat, lng, popularity FROM (
            SELECT ${PLACE_COLUMNS},
                   row_number() OVER (
                     PARTITION BY ${gridCell(bbox, OSM_FILL_GRID)}
                     ORDER BY ${categoryPriority()}, (p.tags ? 'wikidata') DESC, p.id
                   ) AS rank_in_cell,
                   ${categoryPriority()} AS priority, (p.tags ? 'wikidata') AS notable
            FROM places p
            WHERE p."isActive" AND p.source = 'osm' AND p.popularity = 0
              AND ${inBbox(bbox)} ${inCategories(categories)}
          ) spread
          ORDER BY rank_in_cell, priority, notable DESC, id
          LIMIT ${remaining}`
        : [];
    return {
      places: [...tripinly, ...osm].map((row) => toPlaceItem(row, lang)),
      clusters: [],
      attribution: OSM_ATTRIBUTION,
    };
  }

  /** Zoom < 14: Tripinly places only, clustered on a grid when there are more than `limit`. */
  private async inViewOverview(
    bbox: Bbox,
    categories: PlaceCategory[] | undefined,
    limit: number,
    lang: string,
  ): Promise<InViewResponseDto> {
    const rows = await this.prisma.$queryRaw<PlaceRow[]>`
      SELECT ${PLACE_COLUMNS} FROM places p
      WHERE p."isActive" AND p.popularity > 0 AND ${inBbox(bbox)} ${inCategories(categories)}
      ORDER BY p.popularity DESC, p.id
      LIMIT ${limit + 1}`;
    if (rows.length <= limit) {
      return {
        places: rows.map((row) => toPlaceItem(row, lang)),
        clusters: [],
        attribution: OSM_ATTRIBUTION,
      };
    }

    const grid = Math.min(MAX_CLUSTER_GRID, Math.floor(Math.sqrt(limit)));
    const cells = await this.prisma.$queryRaw<
      { count: number; lat: number; lng: number; top: PlaceRow }[]
    >`
      SELECT count(*)::int AS count, avg(p.lat) AS lat, avg(p.lng) AS lng,
             (array_agg(json_build_object(
                'id', p.id, 'name', p.name, 'names', p.names, 'category', p.category,
                'lat', p.lat, 'lng', p.lng, 'popularity', p.popularity)
              ORDER BY p.popularity DESC, p.id))[1] AS top
      FROM places p
      WHERE p."isActive" AND p.popularity > 0 AND ${inBbox(bbox)} ${inCategories(categories)}
      GROUP BY ${gridCell(bbox, grid)}
      ORDER BY count(*) DESC`;

    const places: PlaceItemDto[] = [];
    const clusters: PlaceClusterDto[] = [];
    for (const cell of cells) {
      if (cell.count === 1) {
        places.push(toPlaceItem(cell.top, lang));
      } else {
        clusters.push({
          count: cell.count,
          location: { lat: cell.lat, lng: cell.lng },
        });
      }
    }
    return { places, clusters, attribution: OSM_ATTRIBUTION };
  }

  private async searchOurs(
    q: string,
    lang: string,
    near: { lat: number; lng: number } | undefined,
  ): Promise<SearchResultDto[]> {
    if (!q) return [];
    const proximity = near
      ? Prisma.sql`+ 0.3 / (1 + ST_Distance(p.location, ST_SetSRID(ST_MakePoint(${near.lng}, ${near.lat}), 4326)::geography) / 5000.0)`
      : Prisma.empty;
    const rows = await this.prisma.$queryRaw<
      (PlaceRow & {
        osmType: 'node' | 'way' | 'relation' | null;
        osmId: bigint | null;
      })[]
    >`
      SELECT ${PLACE_COLUMNS}, p."osmType", p."osmId"
      FROM places p
      WHERE p."isActive" AND (p.source = 'osm' OR p.popularity > 0)
        AND ${q} <% p."searchText"
      ORDER BY word_similarity(${q}, p."searchText") + 0.05 * ln(1 + p.popularity) ${proximity} DESC, p.id
      LIMIT ${SEARCH_LIMIT}`;
    return rows.map((row) => {
      const item = toPlaceItem(row, lang);
      return {
        source: 'place',
        id: item.id,
        name: item.name,
        category: item.category,
        location: item.location,
        isTripinly: item.isTripinly,
        likeCount: item.likeCount,
        type: null,
        address: null,
        osmType: row.osmType,
        osmId: row.osmId?.toString() ?? null,
      };
    });
  }

  /** Null when Redis is down: the request then runs uncached. */
  private async inViewCacheKey(
    bbox: Bbox,
    zoom: number,
    categories: PlaceCategory[] | undefined,
    limit: number,
    lang: string,
  ): Promise<string | null> {
    try {
      const version = (await this.redis.get(IN_VIEW_CACHE_VERSION_KEY)) ?? '0';
      const box = [bbox.minLng, bbox.minLat, bbox.maxLng, bbox.maxLat]
        .map((value) => value.toFixed(6))
        .join(',');
      return `places:in-view:v${version}:${zoom}:${box}:${categories?.join(',') ?? '*'}:${limit}:${lang}`;
    } catch {
      return null;
    }
  }

  private async cacheGet<T>(key: string): Promise<T | null> {
    try {
      const value = await this.redis.get(key);
      return value ? (JSON.parse(value) as T) : null;
    } catch {
      return null;
    }
  }

  private async cacheSet(
    key: string,
    value: unknown,
    ttlSeconds: number,
  ): Promise<void> {
    try {
      await this.redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    } catch (error) {
      this.logger.warn(`In-view cache write failed: ${(error as Error).name}`);
    }
  }
}

function inBbox(bbox: Bbox): Prisma.Sql {
  return Prisma.sql`p.location && ST_MakeEnvelope(${bbox.minLng}, ${bbox.minLat}, ${bbox.maxLng}, ${bbox.maxLat}, 4326)::geography`;
}

function inCategories(categories: PlaceCategory[] | undefined): Prisma.Sql {
  return categories
    ? Prisma.sql`AND p.category = ANY(${categories}::"PlaceCategory"[])`
    : Prisma.empty;
}

/** Cell of a grid × grid split of the bbox, as "column, row". */
function gridCell(bbox: Bbox, grid: number): Prisma.Sql {
  return Prisma.sql`
    greatest(1, least(${grid}, width_bucket(p.lng, ${bbox.minLng}, ${bbox.maxLng}, ${grid}))),
    greatest(1, least(${grid}, width_bucket(p.lat, ${bbox.minLat}, ${bbox.maxLat}, ${grid})))`;
}

/** Sights before parks before food and drink. */
function categoryPriority(): Prisma.Sql {
  return Prisma.sql`CASE
    WHEN p.category IN ('attraction', 'museum', 'historic', 'landmark') THEN 0
    WHEN p.category IN ('park', 'nature') THEN 1
    ELSE 2 END`;
}

function asStringRecord(value: Prisma.JsonValue): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') result[key] = entry;
  }
  return result;
}

/** `names["name:<lang>"]` when OSM has it, else the default name. */
export function localizedName(
  row: Pick<PlaceRow, 'name' | 'names'>,
  lang: string,
): string {
  return asStringRecord(row.names)[`name:${lang}`] ?? row.name;
}

/** Plain-object view of the DTO, so callers can spread it into larger shapes. */
type PlaceItem = Pick<PlaceItemDto, keyof PlaceItemDto>;

function toPlaceItem(row: PlaceRow, lang: string): PlaceItem {
  return {
    id: row.id,
    name: localizedName(row, lang),
    category: row.category,
    location: { lat: row.lat, lng: row.lng },
    isTripinly: row.popularity > 0,
    likeCount: row.popularity,
    coverThumbUrl: null,
    likedByMe: false,
  };
}

function encodeScoreCursor(score: number, id: string): string {
  return Buffer.from(JSON.stringify([score, id])).toString('base64url');
}

function decodeScoreCursor(cursor: string): { score: number; id: string } {
  try {
    const [score, id] = JSON.parse(
      Buffer.from(cursor, 'base64url').toString(),
    ) as unknown[];
    if (
      typeof score === 'number' &&
      Number.isFinite(score) &&
      typeof id === 'string' &&
      /^[0-9a-f-]{36}$/i.test(id)
    ) {
      return { score, id };
    }
  } catch {
    // fall through
  }
  throw AppException.validation({ cursor: ['invalidCursor'] });
}
