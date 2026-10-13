import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';
import type { Env } from '../../common/config/env';
import { AppException } from '../../common/errors/app.exception';
import { PrismaService } from '../../common/prisma/prisma.service';
import { REDIS } from '../../common/redis/redis.module';
import { StorageService } from '../../common/storage/storage.service';
import { Prisma, type PlaceCategory } from '../../generated/prisma/client';
import { thumbUrl } from '../photos/photo-keys';
import { likedAmong } from '../social/liked';
import { TripAccessService } from '../trips/trip-access.service';
import {
  assertBboxSpan,
  type Bbox,
  maxSpanForZoom,
  OSM_FILL_MIN_ZOOM,
  parseBbox,
  parseTile,
  snapBbox,
} from './bbox';
import { haversineMeters } from '../routing/geo';
import { normalizePlaceName } from './normalize-name';
import { PhotonClient } from './photon.client';
import {
  PlaceMatchingService,
  type PlaceInput,
} from './place-matching.service';
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
  type TilesQueryDto,
  type TilesResponseDto,
} from './places.dto';

const DEFAULT_IN_VIEW_LIMIT = 100;
/** OSM fill is spread over a GRID × GRID split of the bbox. */
/** OSM places are spread over cells of a quarter tile; clusters group by whole tiles. */
const OSM_FILL_CELLS_PER_TILE = 4;
/** From this zoom on, the overview adds notable OSM places while hot spots are few. */
const OSM_NOTABLE_MIN_ZOOM = 10;
/** Below zoom 14 only places this well known fill the map (about 4,000 page views a year, or more). */
const OSM_NOTABLE_MIN_PROMINENCE = 60;
/** Popular spots have no zoom; this keeps the query to a region. */
const POPULAR_MAX_SPAN_DEGREES = 5;
const DEFAULT_RADIUS_KM = 5;
const NEARBY_TOP_UP_BELOW = 10;
const SEARCH_LIMIT = 10;
/** What a trip can head to: Photon's area layers, never addresses, streets or farms. */
const DESTINATION_LAYERS = [
  'country',
  'state',
  'county',
  'city',
  'district',
] as const;
/** Districts and counties after countries, regions and cities. */
const BROAD_DESTINATION_TYPES = new Set(['country', 'state', 'city']);
/** The same name this close is one destination (Vienna the city and the state). */
const SAME_DESTINATION_METERS = 30_000;
/** A tapped point takes the name of one of our public places this close. */
const PLACE_AT_RADIUS_METERS = 25;
const PLACE_PHOTO_LIMIT = 10;
/** Sights that top up Nearby; cafés and bars are too many to be useful there. */
const SIGHT_CATEGORIES: PlaceCategory[] = [
  'attraction',
  'museum',
  'historic',
  'landmark',
];

export interface PlaceRow {
  id: string;
  name: string;
  names: Prisma.JsonValue;
  category: PlaceCategory;
  lat: number;
  lng: number;
  popularity: number;
  prominence: number;
}

/** Columns every place list selects (PlaceRow). */
export const PLACE_COLUMNS = Prisma.sql`p.id, p.name, p.names, p.category, p.lat, p.lng, p.popularity, p.prominence`;

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
    private readonly storage: StorageService,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async inView(
    userId: string,
    query: InViewQueryDto,
    lang: string,
  ): Promise<InViewResponseDto> {
    const requested = parseBbox(query.bbox);
    assertBboxSpan(requested, maxSpanForZoom(query.zoom));
    const result = await this.placesIn(requested, query, lang);
    return {
      places: await this.personalize(userId, result.places),
      clusters: result.clusters,
      attribution: result.attribution,
    };
  }

  /**
   * In-view for several map squares at once, so the app can load the map by square, keep squares
   * and fetch the ones around the view ahead. Each square gets exactly what in-view returns for it.
   */
  async tiles(
    userId: string,
    query: TilesQueryDto,
    lang: string,
  ): Promise<TilesResponseDto> {
    const keys = [...new Set(query.tiles.split(','))];
    const squares = keys.map((key) => ({ key, bbox: parseTile(key) }));
    for (const square of squares) {
      assertBboxSpan(square.bbox, maxSpanForZoom(query.zoom));
    }
    const results = await Promise.all(
      squares.map((square) => this.placesIn(square.bbox, query, lang)),
    );
    // One look-up of covers and likes for every square.
    const places = await this.personalize(
      userId,
      results.flatMap((result) => result.places),
    );
    let next = 0;
    return {
      tiles: squares.map((square, index) => {
        const count = results[index].places.length;
        const tile = {
          tile: square.key,
          places: places.slice(next, next + count),
          clusters: results[index].clusters,
        };
        next += count;
        return tile;
      }),
      attribution: OSM_ATTRIBUTION,
    };
  }

  /** In-view for one area, the same for every viewer and cached for everyone. */
  private async placesIn(
    requested: Bbox,
    query: Pick<InViewQueryDto, 'zoom' | 'categories' | 'limit'>,
    lang: string,
  ): Promise<InViewResponseDto> {
    const zoom = Math.floor(query.zoom);
    const bbox = snapBbox(requested, zoom);
    const limit = query.limit ?? DEFAULT_IN_VIEW_LIMIT;
    const categories = query.categories?.length
      ? [...query.categories].sort()
      : undefined;

    const key = await this.inViewCacheKey(bbox, zoom, categories, limit, lang);
    // The cache is shared by everyone; covers and likedByMe are per viewer.
    const cached = key ? await this.cacheGet<InViewResponseDto>(key) : null;
    const result =
      cached ??
      (zoom >= OSM_FILL_MIN_ZOOM
        ? await this.inViewDetailed(bbox, zoom, categories, limit, lang)
        : await this.inViewOverview(bbox, zoom, categories, limit, lang));
    if (key && !cached) {
      await this.cacheSet(key, result, IN_VIEW_CACHE_TTL_SECONDS);
    }
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
      items: await this.personalize(
        userId,
        rows.map((row) => toPlaceItem(row, lang)),
      ),
      attribution: OSM_ATTRIBUTION,
    };
  }

  async nearby(
    userId: string,
    query: NearbyQueryDto,
    lang: string,
  ): Promise<NearbyPageDto> {
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
      items: await this.personalize(userId, items),
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
    if (query.scope === 'destination') {
      const areas = await this.photon.search({
        q: query.q,
        lang,
        near,
        layers: DESTINATION_LAYERS,
      });
      return { items: destinations(areas), attribution: OSM_ATTRIBUTION };
    }
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

  /**
   * What a stop tapped on the map is: one of our public places within 25 m,
   * else the Photon address there, else a place named by its coordinates.
   * The point is used for this lookup only and not logged.
   */
  async placeAt(lat: number, lng: number, lang: string): Promise<PlaceInput> {
    const point = Prisma.sql`ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography`;
    const [ours] = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT p.id FROM places p
      WHERE p."isActive" AND (p.source = 'osm' OR p.popularity > 0)
        AND ST_DWithin(p.location, ${point}, ${PLACE_AT_RADIUS_METERS})
      ORDER BY p.location <-> ${point}
      LIMIT 1`;
    if (ours) return { placeId: ours.id };

    const address = await this.photon.reverse({ lat, lng, lang });
    return {
      name: address?.name ?? `${lat.toFixed(5)}, ${lng.toFixed(5)}`,
      lat,
      lng,
      osm:
        address?.osmType && address.osmId
          ? { type: address.osmType, id: BigInt(address.osmId) }
          : undefined,
    };
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
        prominence: true,
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
    const [item] = await this.personalize(userId, [toPlaceItem(place, lang)]);
    return {
      ...item,
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
      photoThumbUrls: await this.placePhotoThumbs(userId, place.id),
      attribution:
        place.source === 'osm' || place.osmId ? OSM_ATTRIBUTION : null,
    };
  }

  /**
   * Fills each place's cover (its most liked photo that may represent it, see
   * `representativePhotos`; left out across blocks) and likedByMe for this
   * viewer.
   */
  async personalize<T extends PlaceItem>(
    userId: string,
    items: T[],
  ): Promise<T[]> {
    const ids = items.map((item) => item.id);
    if (ids.length === 0) return items;
    const [covers, liked] = await Promise.all([
      this.prisma.$queryRaw<{ placeId: string; photoId: string }[]>`
        SELECT DISTINCT ON (q."placeId") q."placeId" AS "placeId", q.id AS "photoId"
        FROM (${this.representativePhotos(
          userId,
          Prisma.sql`m."placeId" = ANY(${ids}::uuid[])`,
        )}) q
        ORDER BY q."placeId", q."outsideLikes" DESC, q."likeCount" DESC, q."createdAt" DESC, q.id`,
      likedAmong(this.prisma, userId, { type: 'place', ids }),
    ]);
    const coverOf = new Map(covers.map((row) => [row.placeId, row.photoId]));
    return items.map((item) => {
      const photoId = coverOf.get(item.id) ?? null;
      return {
        ...item,
        coverPhotoId: photoId,
        coverThumbUrl: thumbUrl(this.storage, photoId),
        likedByMe: liked.has(item.id),
      };
    });
  }

  /** Up to 10 photos that may represent the place, most outside likes first. */
  private async placePhotoThumbs(
    userId: string,
    placeId: string,
  ): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT q.id FROM (${this.representativePhotos(
        userId,
        Prisma.sql`m."placeId" = ${placeId}::uuid`,
      )}) q
      ORDER BY q."outsideLikes" DESC, q."likeCount" DESC, q."createdAt" DESC, q.id
      LIMIT ${PLACE_PHOTO_LIMIT}`;
    return rows.flatMap((row) => thumbUrl(this.storage, row.id) ?? []);
  }

  /**
   * Ready photos in public trips that may represent a place: at least
   * APP_PLACE_PHOTO_MIN_OUTSIDE_LIKES people liked them who are neither the
   * uploader, the trip owner nor a member of that trip, so nobody can make
   * their own photo a place's image. Hidden content, suspended owners and
   * blocks either way with the viewer (uploader or owner) are left out.
   * Columns: id, placeId, outsideLikes, likeCount, createdAt.
   */
  private representativePhotos(
    userId: string,
    placeFilter: Prisma.Sql,
  ): Prisma.Sql {
    const minLikes = this.config.get('APP_PLACE_PHOTO_MIN_OUTSIDE_LIKES', {
      infer: true,
    });
    return Prisma.sql`
      SELECT ph.id, m."placeId", outside.n AS "outsideLikes", ph."likeCount", ph."createdAt"
      FROM photos ph
      JOIN markers m ON m.id = ph."markerId"
      JOIN trips t ON t.id = m."tripId"
      CROSS JOIN LATERAL (
        SELECT count(*)::int AS n FROM likes l
        WHERE l."targetType" = 'photo' AND l."targetId" = ph.id
          AND l."userId" <> ph."uploaderId" AND l."userId" <> t."ownerId"
          AND NOT EXISTS (
            SELECT 1 FROM trip_members tm WHERE tm."tripId" = t.id AND tm."userId" = l."userId")
      ) outside
      WHERE ${placeFilter} AND ph.status = 'ready' AND ph."hiddenAt" IS NULL
        AND ph."likeCount" >= ${minLikes}
        AND m."hiddenAt" IS NULL AND t.visibility = 'public' AND t."hiddenAt" IS NULL
        AND ${ownerActive(Prisma.sql`t."ownerId"`)}
        AND ${notBlockedWith(userId, Prisma.sql`ph."uploaderId"`)}
        AND ${notBlockedWith(userId, Prisma.sql`t."ownerId"`)}
        AND outside.n >= ${minLikes}`;
  }

  /**
   * Zoom ≥ 14: Tripinly places by popularity, then OSM places spread over the view.
   * The spreading cells are fixed on the map, not on the view, so panning keeps the
   * same picks for the same streets.
   */
  private async inViewDetailed(
    bbox: Bbox,
    zoom: number,
    categories: PlaceCategory[] | undefined,
    limit: number,
    lang: string,
  ): Promise<InViewResponseDto> {
    const minLikes = this.rankMinLikes();
    const tripinly = await this.prisma.$queryRaw<PlaceRow[]>`
      SELECT ${PLACE_COLUMNS} FROM places p
      WHERE p."isActive" AND p.popularity >= ${minLikes} AND ${inBbox(bbox)} ${inCategories(categories)}
      ORDER BY p.popularity DESC, p.id
      LIMIT ${limit}`;
    const osm = await this.osmFill(
      bbox,
      zoom,
      categories,
      limit - tripinly.length,
      minLikes,
      false,
    );
    return {
      places: [...tripinly, ...osm].map((row) => toPlaceItem(row, lang)),
      clusters: [],
      attribution: OSM_ATTRIBUTION,
    };
  }

  /**
   * Zoom < 14: Tripinly places, clustered per map tile when there are more than `limit`;
   * from zoom 10, well-known OSM places fill up to `limit`.
   */
  private async inViewOverview(
    bbox: Bbox,
    zoom: number,
    categories: PlaceCategory[] | undefined,
    limit: number,
    lang: string,
  ): Promise<InViewResponseDto> {
    const minLikes = this.rankMinLikes();
    const rows = await this.prisma.$queryRaw<PlaceRow[]>`
      SELECT ${PLACE_COLUMNS} FROM places p
      WHERE p."isActive" AND p.popularity >= ${minLikes} AND ${inBbox(bbox)} ${inCategories(categories)}
      ORDER BY p.popularity DESC, p.id
      LIMIT ${limit + 1}`;
    if (rows.length <= limit) {
      // Until there are enough hot spots, OSM's notable places fill the map.
      const osm =
        zoom >= OSM_NOTABLE_MIN_ZOOM
          ? await this.osmFill(
              bbox,
              zoom,
              categories,
              limit - rows.length,
              minLikes,
              true,
            )
          : [];
      return {
        places: [...rows, ...osm].map((row) => toPlaceItem(row, lang)),
        clusters: [],
        attribution: OSM_ATTRIBUTION,
      };
    }

    const cells = await this.prisma.$queryRaw<
      { count: number; lat: number; lng: number; top: PlaceRow }[]
    >`
      SELECT count(*)::int AS count, avg(p.lat) AS lat, avg(p.lng) AS lng,
             (array_agg(json_build_object(
                'id', p.id, 'name', p.name, 'names', p.names, 'category', p.category,
                'lat', p.lat, 'lng', p.lng, 'popularity', p.popularity,
                'prominence', p.prominence)
              ORDER BY p.popularity DESC, p.id))[1] AS top
      FROM places p
      WHERE p."isActive" AND p.popularity >= ${minLikes} AND ${inBbox(bbox)} ${inCategories(categories)}
      GROUP BY ${mapCell(tileSize(zoom))}
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

  /**
   * Places with fewer than `minLikes` likes (OSM places, and liked user places).
   * Well-known places (prominence ≥ OSM_NOTABLE_MIN_PROMINENCE) come first, the
   * best known first, so a place shown at one zoom stays at every closer zoom:
   * a map square's top places are also the top places of the smaller squares
   * inside it. The rest are spread over cells fixed on the map (so panning keeps
   * the same picks): each cell's best place first, sights before parks before
   * food, the best known first. `notableOnly` keeps the well-known places only
   * (10-maps-places-routing.md).
   */
  private async osmFill(
    bbox: Bbox,
    zoom: number,
    categories: PlaceCategory[] | undefined,
    limit: number,
    minLikes: number,
    notableOnly: boolean,
  ): Promise<PlaceRow[]> {
    if (limit <= 0) return [];
    const notable = notableOnly
      ? Prisma.sql`AND p.prominence >= ${OSM_NOTABLE_MIN_PROMINENCE}`
      : Prisma.empty;
    return this.prisma.$queryRaw<PlaceRow[]>`
      SELECT id, name, names, category, lat, lng, popularity, prominence FROM (
        SELECT ${PLACE_COLUMNS},
               row_number() OVER (
                 PARTITION BY ${mapCell(tileSize(zoom) / OSM_FILL_CELLS_PER_TILE)}
                 ORDER BY ${categoryPriority()}, p.prominence DESC, p.id
               ) AS rank_in_cell,
               ${categoryPriority()} AS priority
        FROM places p
        WHERE p."isActive" AND (p.source = 'osm' OR p.popularity > 0)
          AND p.popularity < ${minLikes}
          AND ${inBbox(bbox)} ${inCategories(categories)} ${notable}
      ) spread
      ORDER BY
        CASE WHEN prominence >= ${OSM_NOTABLE_MIN_PROMINENCE} THEN prominence END DESC NULLS LAST,
        CASE WHEN prominence >= ${OSM_NOTABLE_MIN_PROMINENCE} THEN id END,
        rank_in_cell, priority, prominence DESC, id
      LIMIT ${limit}`;
  }

  /** Likes a place needs to rank above prominence on the map (APP_PLACE_RANK_MIN_LIKES). */
  private rankMinLikes(): number {
    return this.config.get('APP_PLACE_RANK_MIN_LIKES', { infer: true });
  }

  private async searchOurs(
    q: string,
    lang: string,
    near: { lat: number; lng: number } | undefined,
  ): Promise<SearchResultDto[]> {
    // Trigram matching needs two characters; one letter is left to Photon's prefix search.
    if (q.length < 2) return [];
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

/** No block between `userId` and the user in `column`, in either direction. */
function notBlockedWith(userId: string, column: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`NOT EXISTS (
    SELECT 1 FROM blocks b
    WHERE (b."blockerId" = ${userId}::uuid AND b."blockedId" = ${column})
       OR (b."blockedId" = ${userId}::uuid AND b."blockerId" = ${column}))`;
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
/** Width of a map tile at `zoom`, in degrees. */
function tileSize(zoom: number): number {
  return 360 / 2 ** zoom;
}

/** A square cell of the given size, anchored at 0°/0° so it doesn't move with the view. */
function mapCell(size: number): Prisma.Sql {
  return Prisma.sql`floor(p.lng / ${size}), floor(p.lat / ${size})`;
}

/** Sights before parks before food and drink. */
export function categoryPriority(): Prisma.Sql {
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
export type PlaceItem = Pick<PlaceItemDto, keyof PlaceItemDto>;

export function toPlaceItem(row: PlaceRow, lang: string): PlaceItem {
  return {
    id: row.id,
    name: localizedName(row, lang),
    category: row.category,
    location: { lat: row.lat, lng: row.lng },
    isTripinly: row.popularity > 0,
    likeCount: row.popularity,
    prominence: row.prominence,
    coverPhotoId: null,
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

/** Suspended (or deleting) users' public content leaves discovery. */
function ownerActive(ownerId: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`EXISTS (SELECT 1 FROM users u WHERE u.id = ${ownerId} AND u.status = 'active')`;
}

/**
 * Photon's areas, most important first as Photon ranks them, with countries,
 * regions and cities ahead of districts and counties, and each name only once
 * per place.
 */
export function destinations(areas: SearchResultDto[]): SearchResultDto[] {
  const ordered = [
    ...areas.filter((area) => BROAD_DESTINATION_TYPES.has(area.type ?? '')),
    ...areas.filter((area) => !BROAD_DESTINATION_TYPES.has(area.type ?? '')),
  ];
  return ordered.filter(
    (area, index) =>
      !ordered
        .slice(0, index)
        .some(
          (earlier) =>
            earlier.name === area.name &&
            haversineMeters(earlier.location, area.location) <
              SAME_DESTINATION_METERS,
        ),
  );
}
