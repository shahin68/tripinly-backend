import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';
import type { Env } from '../../common/config/env';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { PrismaService } from '../../common/prisma/prisma.service';
import { REDIS } from '../../common/redis/redis.module';
import { StorageService } from '../../common/storage/storage.service';
import { Prisma, type PlaceCategory } from '../../generated/prisma/client';
import { EntitlementService } from '../billing/entitlement.service';
import { PremiumFeature } from '../billing/entitlements';
import { photoKeys } from '../photos/photo-keys';
import { BlocksService } from '../moderation/blocks.service';
import { likedAmong } from '../social/liked';
import { TripAccessService } from '../trips/trip-access.service';
import {
  USER_SUMMARY_SELECT,
  toUserSummary,
  type UserSummaryDto,
} from '../users/user-summary';
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
import { placeImageCredit } from './commons-metadata';
import { BEST_PHOTO_FIRST, PlaceCoversService } from './place-covers.service';
import { BrandPolicy, type BrandRef } from './brands';
import { PhotonClient } from './photon.client';
import {
  inBox,
  isArea,
  keepPhotonResult,
  mergeSearchResults,
  photonScore,
  type Scored,
  SEARCH_WEIGHTS,
  searchWords,
  SQL_WORD_SEPARATORS,
} from './search-ranking';
import { PUBLIC_STOP_WHERE } from './popularity';
import { placeImageKeys } from './place-image-keys';
import {
  PlaceMatchingService,
  type PlaceInput,
} from './place-matching.service';
import {
  IN_VIEW_CACHE_TTL_SECONDS,
  IN_VIEW_CACHE_VERSION_KEY,
} from './places-cache';
import {
  AROUND_DEFAULT_RADIUS_METERS,
  type AroundQueryDto,
  type AroundResponseDto,
  type CategoryCountDto,
  type InViewQueryDto,
  type InViewResponseDto,
  type NearbyPageDto,
  type NearbyPlaceDto,
  type NearbyQueryDto,
  OSM_ATTRIBUTION,
  type PlaceClusterDto,
  type PlaceImageDto,
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
/** A place's Commons images: most liked first, then in Commons order. */
export const COMMONS_ORDER = [
  { likeCount: 'desc' },
  { rank: 'asc' },
  { id: 'asc' },
] satisfies Prisma.PlaceImageOrderByWithRelationInput[];

/** OSM places are spread over cells of a quarter tile; clusters group by whole tiles. */
const OSM_FILL_CELLS_PER_TILE = 4;
/** From this zoom on, the overview adds notable OSM places while hot spots are few. */
const OSM_NOTABLE_MIN_ZOOM = 10;
/** Below zoom 14 only places this well known fill the map (about 4,000 page views a year, or more). */
const OSM_NOTABLE_MIN_PROMINENCE = 60;
/** Around spreads its places over cells this many per radius (a quarter of it). */
const AROUND_CELLS_PER_RADIUS = 4;
const METERS_PER_DEGREE = 111_320;
/** Popular spots have no zoom; this keeps the query to a region. */
const POPULAR_MAX_SPAN_DEGREES = 5;
const DEFAULT_RADIUS_KM = 5;
const NEARBY_TOP_UP_BELOW = 10;
const SEARCH_LIMIT = 10;
/** Our best matches before those outside the map's city are left out. */
const OURS_CANDIDATES = 40;
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
  'viewpoint',
  'zoo',
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
  /** Selected by PLACE_COLUMNS; absent where a query doesn't need it. */
  brand?: BrandRef | null;
}

/** A place's brand as JSON (`BrandRef`), null without one. */
const BRAND_JSON = Prisma.sql`(SELECT json_build_object('id', b.id, 'name', b.name, 'wikidataId', b."wikidataId", 'logoHash', b."logoHash") FROM brands b WHERE b.id = p."brandId")`;

/** Columns every place list selects (PlaceRow). */
export const PLACE_COLUMNS = Prisma.sql`p.id, p.name, p.names, p.category, p.lat, p.lng, p.popularity, p.prominence, ${BRAND_JSON} AS brand`;

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
    private readonly covers: PlaceCoversService,
    private readonly entitlements: EntitlementService,
    private readonly brands: BrandPolicy,
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
    query: Pick<InViewQueryDto, 'zoom' | 'categories' | 'limit'> & {
      q?: string;
    },
    lang: string,
  ): Promise<InViewResponseDto> {
    const zoom = Math.floor(query.zoom);
    const bbox = snapBbox(requested, zoom);
    const limit = query.limit ?? DEFAULT_IN_VIEW_LIMIT;
    if (query.q) return this.placesNamed(bbox, query.q, limit, lang);
    const categories = query.categories?.length
      ? [...query.categories].sort()
      : undefined;

    const key = await this.inViewCacheKey(bbox, zoom, categories, limit, lang);
    // The cache is shared by everyone; covers and hotByMe are per viewer.
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
      WHERE p."isActive" AND p.popularity > 0 ${osmPinsFilter(this.osmPins())} AND ${inBbox(bbox)} ${exclude}
      ORDER BY p.popularity DESC, p.id
      LIMIT ${query.limit ?? 20}`;
    return {
      items: await this.personalize(
        userId,
        rows.map((row) => toPlaceItem(row, lang, this.brands)),
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
        WHERE p."isActive" AND p.popularity > 0 ${osmPinsFilter(this.osmPins())}
          AND ST_DWithin(p.location, ${point}, ${radius})
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
      ...toPlaceItem(row, lang, this.brands),
      distanceMeters: Math.round(row.distance),
    }));
    const hasMore = rows.length > limit;
    const last = kept[kept.length - 1];

    // Few liked places around: top the first page up with OSM sights by distance (while OSM pins are on).
    if (
      this.osmPins() &&
      !after &&
      !hasMore &&
      items.length < NEARBY_TOP_UP_BELOW
    ) {
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
          ...toPlaceItem(row, lang, this.brands),
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

  /**
   * Around a pin (Tripinly Pro, the same entitlement as routes): the places
   * in the circle, at most APP_AROUND_MAX_PINS, with how many of each kind
   * the circle holds. When the circle holds more, they are spread over it
   * (Shahin, 2026-11-18): the ring is cut into a grid of cells (a quarter of
   * the radius wide) and each cell's best place goes first (hot spots, then
   * Tripinly spots, then the best known, then nearest), so a bigger ring
   * shows places out to its edge instead of only the nearest ones. The ones
   * picked are listed hot spots first, Tripinly spots before OSM places, then
   * nearest. Private spots never count (popularity only counts public trips).
   * The pin the ring is around (excludePlaceId) is left out. The point is
   * used for this query only.
   */
  async around(
    userId: string,
    query: AroundQueryDto,
    lang: string,
  ): Promise<AroundResponseDto> {
    if (!(await this.entitlements.has(userId, PremiumFeature.ROUTES))) {
      throw new AppException(ErrorCode.PREMIUM_REQUIRED, HttpStatus.FORBIDDEN);
    }
    const radius = query.radiusMeters ?? AROUND_DEFAULT_RADIUS_METERS;
    const point = Prisma.sql`ST_SetSRID(ST_MakePoint(${query.lng}, ${query.lat}), 4326)::geography`;
    const notThePin = query.excludePlaceId
      ? Prisma.sql`AND p.id <> ${query.excludePlaceId}::uuid`
      : Prisma.empty;
    const inCircle = Prisma.sql`p."isActive" AND (p.source = 'osm' OR p.popularity > 0)
      ${osmPinsFilter(this.osmPins())} AND ST_DWithin(p.location, ${point}, ${radius}) ${notThePin}`;
    const minLikes = this.rankMinLikes();
    const maxPins = this.config.get('APP_AROUND_MAX_PINS', { infer: true });
    const limit = Math.min(query.limit ?? maxPins, maxPins);
    // Cells a quarter of the radius wide, in degrees (longitude ones wider away from the equator).
    const cellLat = radius / AROUND_CELLS_PER_RADIUS / METERS_PER_DEGREE;
    const cellLng =
      cellLat / Math.max(Math.cos((query.lat * Math.PI) / 180), 0.01);
    const [rows, counts] = await Promise.all([
      this.prisma.$queryRaw<(PlaceRow & { distance: number })[]>`
        SELECT id, name, names, category, lat, lng, popularity, prominence, brand, distance FROM (
          SELECT * FROM (
            SELECT ${PLACE_COLUMNS}, ST_Distance(p.location, ${point}) AS distance,
                   CASE WHEN p.popularity >= ${minLikes} THEN p.popularity ELSE 0 END AS hot,
                   (p.source <> 'osm') AS ours,
                   row_number() OVER (
                     PARTITION BY floor(p.lng / ${cellLng}), floor(p.lat / ${cellLat})
                     ORDER BY CASE WHEN p.popularity >= ${minLikes} THEN p.popularity ELSE 0 END DESC,
                              (p.source <> 'osm') DESC, p.prominence DESC,
                              ST_Distance(p.location, ${point}), p.id
                   ) AS rank_in_cell
            FROM places p
            WHERE ${inCircle} ${inCategories(query.categories)}
          ) spread
          ORDER BY hot DESC, ours DESC, rank_in_cell, prominence DESC, distance, id
          LIMIT ${limit}
        ) picked
        ORDER BY hot DESC, ours DESC, distance, id`,
      this.prisma.$queryRaw<CategoryCountDto[]>`
        SELECT p.category, count(*)::int AS count
        FROM places p
        WHERE ${inCircle}
        GROUP BY p.category
        ORDER BY count DESC, p.category`,
    ]);
    const items: NearbyPlaceDto[] = rows.map((row) => ({
      ...toPlaceItem(row, lang, this.brands),
      distanceMeters: Math.round(row.distance),
    }));
    return {
      items: await this.personalize(userId, items),
      categoryCounts: counts,
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
      return {
        items: destinations(areas),
        city: null,
        attribution: OSM_ATTRIBUTION,
      };
    }
    // Places come from the city the map is in while it has any; otherwise from
    // anywhere, so the camera can go to another city (Shahin, 2026-11-20). Its
    // bounds are looked up while the places are, and the app frames by them.
    // While OSM pins are off only our users' places are found: no Photon addresses either.
    const [ours, photon, city] = await Promise.all([
      this.searchOurs(query.q, lang, near),
      this.osmPins()
        ? this.photon.search({ q: query.q, lang, near })
        : Promise.resolve([]),
      near ? this.photon.cityAt({ ...near, lang }) : Promise.resolve(null),
    ]);
    const cityHasAny =
      !!city &&
      (ours.some(({ item }) => inBox(item.location, city)) ||
        photon.some(
          (item) => !isArea(item) && keepPhotonResult(item, query.q, city),
        ));
    const within = cityHasAny ? city : null;
    const scored = photon
      .filter((item) => keepPhotonResult(item, query.q, within))
      .map((item) => ({ item, score: photonScore(item, query.q, near) }));
    const inCity = within
      ? ours.filter(({ item }) => inBox(item.location, within))
      : ours;
    return {
      items: mergeSearchResults(inCity, scored, SEARCH_LIMIT),
      city: city && {
        west: city.minLng,
        south: city.minLat,
        east: city.maxLng,
        north: city.maxLat,
      },
      attribution: OSM_ATTRIBUTION,
    };
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
        createdById: true,
        brand: {
          select: { id: true, name: true, wikidataId: true, logoHash: true },
        },
      },
    });
    if (
      !place ||
      !(await this.matching.isVisible(this.prisma, userId, place))
    ) {
      throw AppException.notFound();
    }
    const tags = asStringRecord(place.tags);
    const [[item], tripPhotos, commons, addedBy] = await Promise.all([
      this.personalize(userId, [toPlaceItem(place, lang, this.brands)]),
      this.placeTripPhotos(userId, place.id),
      this.placeCommonsImages(place.id),
      this.addedBy(userId, place.id, place.createdById),
    ]);
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
      photoThumbUrls: tripPhotos.flatMap((photo) => photo.thumbUrl ?? []),
      images: [...tripPhotos, ...commons],
      addedBy,
      attribution:
        place.source === 'osm' || place.osmId ? OSM_ATTRIBUTION : null,
    };
  }

  /**
   * Who made a user place, credited only while they have it on a visible stop
   * of their own public, visible trip, so a private trip never shows; never to
   * someone with a block either way, and never for a suspended or deleted account.
   */
  private async addedBy(
    userId: string,
    placeId: string,
    creatorId: string | null,
  ): Promise<UserSummaryDto | null> {
    if (!creatorId) return null;
    const [stop, blocked] = await Promise.all([
      this.prisma.marker.findFirst({
        where: {
          ...PUBLIC_STOP_WHERE,
          placeId,
          createdById: creatorId,
          createdBy: { status: 'active' },
        },
        select: { createdBy: { select: USER_SUMMARY_SELECT } },
      }),
      BlocksService.blockedAmong(this.prisma, userId, [creatorId]),
    ]);
    if (!stop?.createdBy || blocked.size > 0) return null;
    return toUserSummary(stop.createdBy, this.storage);
  }

  /**
   * Fills each place's cover (see `coversOf`) and hotByMe for this viewer.
   */
  async personalize<T extends PlaceItem>(
    userId: string,
    items: T[],
  ): Promise<T[]> {
    const ids = items.map((item) => item.id);
    if (ids.length === 0) return items;
    const [covers, liked] = await Promise.all([
      this.covers.coversOf(userId, ids),
      likedAmong(this.prisma, userId, { type: 'place', ids }),
    ]);
    return items.map((item) => {
      const cover = covers.get(item.id);
      return {
        ...item,
        coverPhotoId: cover?.source === 'trip' ? cover.id : null,
        coverImageId: cover?.id ?? null,
        coverSource: cover?.source ?? null,
        coverThumbUrl: cover?.thumbUrl ?? null,
        hotByMe: liked.has(item.id),
      };
    });
  }

  /** Up to 10 photos that may represent the place, most likes first. */
  private async placeTripPhotos(
    userId: string,
    placeId: string,
  ): Promise<PlaceImageDto[]> {
    const rows = await this.prisma.$queryRaw<
      {
        id: string;
        width: number | null;
        height: number | null;
        uploaderId: string;
      }[]
    >`
      SELECT q.id, p.width, p.height, p."uploaderId" FROM (${this.covers.representativePhotos(userId, [placeId])}) q
      JOIN photos p ON p.id = q.id
      ORDER BY ${BEST_PHOTO_FIRST}
      LIMIT ${PLACE_PHOTO_LIMIT}`;
    // Uploaders are credited, except someone with a block either way.
    const uploaderIds = [...new Set(rows.map((row) => row.uploaderId))];
    const [uploaders, blocked] = await Promise.all([
      this.prisma.user.findMany({
        where: { id: { in: uploaderIds } },
        select: USER_SUMMARY_SELECT,
      }),
      BlocksService.blockedAmong(this.prisma, userId, uploaderIds),
    ]);
    const uploaderById = new Map(uploaders.map((user) => [user.id, user]));
    const credited = (id: string) => {
      const user = blocked.has(id) ? undefined : uploaderById.get(id);
      return user ? toUserSummary(user, this.storage) : null;
    };
    return rows.map((row) => ({
      id: row.id,
      source: 'trip',
      thumbUrl: this.storage.signedGetUrl(photoKeys(row.id).thumb),
      displayUrl: this.storage.signedGetUrl(photoKeys(row.id).display),
      width: row.width,
      height: row.height,
      credit: null,
      uploader: credited(row.uploaderId),
    }));
  }

  /** The place's ready Commons images, most liked first, each with its credit. */
  private async placeCommonsImages(placeId: string): Promise<PlaceImageDto[]> {
    const rows = await this.prisma.placeImage.findMany({
      where: { placeId, status: 'ready' },
      orderBy: COMMONS_ORDER,
    });
    return rows.map((row) => {
      const keys = placeImageKeys(row.id);
      return {
        id: row.id,
        source: 'commons',
        thumbUrl: this.storage.signedGetUrl(keys.thumb),
        displayUrl: this.storage.signedGetUrl(keys.display),
        width: row.width,
        height: row.height,
        credit: placeImageCredit(row),
        uploader: null,
      };
    });
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
      WHERE p."isActive" AND p.popularity >= ${minLikes} ${osmPinsFilter(this.osmPins())}
        AND ${inBbox(bbox)} ${inCategories(categories)}
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
      places: [...tripinly, ...osm].map((row) =>
        toPlaceItem(row, lang, this.brands),
      ),
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
      WHERE p."isActive" AND p.popularity >= ${minLikes} ${osmPinsFilter(this.osmPins())}
        AND ${inBbox(bbox)} ${inCategories(categories)}
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
        places: [...rows, ...osm].map((row) =>
          toPlaceItem(row, lang, this.brands),
        ),
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
                'prominence', p.prominence, 'brand', ${BRAND_JSON})
              ORDER BY p.popularity DESC, p.id))[1] AS top
      FROM places p
      WHERE p."isActive" AND p.popularity >= ${minLikes} ${osmPinsFilter(this.osmPins())}
        AND ${inBbox(bbox)} ${inCategories(categories)}
      GROUP BY ${mapCell(tileSize(zoom))}
      ORDER BY count(*) DESC`;

    const places: PlaceItemDto[] = [];
    const clusters: PlaceClusterDto[] = [];
    for (const cell of cells) {
      if (cell.count === 1) {
        places.push(toPlaceItem(cell.top, lang, this.brands));
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
   * The map searched by name (`q`): every listed place in the square whose name
   * matches as search does, at any zoom, hot first, then the best known. Not
   * cached: searches are many and short-lived.
   */
  private async placesNamed(
    bbox: Bbox,
    q: string,
    limit: number,
    lang: string,
  ): Promise<InViewResponseDto> {
    const normalized = normalizePlaceName(q);
    const words = searchWords(q);
    if (normalized.length < 2 || !words) {
      return { places: [], clusters: [], attribution: OSM_ATTRIBUTION };
    }
    const like = (text: string) => text.replace(/[\\%_]/g, '\\$&');
    const rows = await this.prisma.$queryRaw<PlaceRow[]>`
      SELECT ${PLACE_COLUMNS} FROM places p
      WHERE p."isActive" AND (p.source = 'osm' OR p.popularity > 0)
        ${osmPinsFilter(this.osmPins())} AND ${inBbox(bbox)}
        AND (${normalized} <% p."searchText" OR p."searchText" LIKE ${'%' + like(normalized) + '%'})
        AND ${searchTextWords()} LIKE ${'% ' + like(words) + '%'}
      ORDER BY p.popularity DESC, p.prominence DESC, p.id
      LIMIT ${limit}`;
    return {
      places: rows.map((row) => toPlaceItem(row, lang, this.brands)),
      clusters: [],
      attribution: OSM_ATTRIBUTION,
    };
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
      SELECT id, name, names, category, lat, lng, popularity, prominence, brand FROM (
        SELECT ${PLACE_COLUMNS},
               row_number() OVER (
                 PARTITION BY ${mapCell(tileSize(zoom) / OSM_FILL_CELLS_PER_TILE)}
                 ORDER BY ${categoryPriority()}, p.prominence DESC, p.id
               ) AS rank_in_cell,
               ${categoryPriority()} AS priority
        FROM places p
        WHERE p."isActive" AND (p.source = 'osm' OR p.popularity > 0)
          ${osmPinsFilter(this.osmPins())} AND p.popularity < ${minLikes}
          AND ${inBbox(bbox)} ${inCategories(categories)} ${notable}
      ) spread
      ORDER BY
        CASE WHEN prominence >= ${OSM_NOTABLE_MIN_PROMINENCE} THEN prominence END DESC NULLS LAST,
        CASE WHEN prominence >= ${OSM_NOTABLE_MIN_PROMINENCE} THEN id END,
        rank_in_cell, priority, prominence DESC, id
      LIMIT ${limit}`;
  }

  /** Whether OpenStreetMap places are listed at all (OSM_PINS_ENABLED). */
  private osmPins(): boolean {
    return this.config.get('OSM_PINS_ENABLED', { infer: true });
  }

  /** Hot count a place needs to rank above prominence on the map (APP_PLACE_RANK_MIN_HOT_COUNT). */
  private rankMinLikes(): number {
    return this.config.get('APP_PLACE_RANK_MIN_HOT_COUNT', { infer: true });
  }

  /** Our places for a search, each with its score (see `search-ranking.ts`). */
  private async searchOurs(
    query: string,
    lang: string,
    near: { lat: number; lng: number } | undefined,
  ): Promise<Scored[]> {
    const q = normalizePlaceName(query);
    // Trigram matching needs two characters; one letter is left to Photon's prefix search.
    const words = searchWords(query);
    if (q.length < 2 || !words) return [];
    const like = (text: string) => text.replace(/[\\%_]/g, '\\$&');
    const w = SEARCH_WEIGHTS;
    const proximity = near
      ? Prisma.sql`+ ${w.near}::float8 / (1 + ST_Distance(p.location, ST_SetSRID(ST_MakePoint(${near.lng}, ${near.lat}), 4326)::geography) / ${w.nearMeters}::float8)`
      : Prisma.empty;
    const name = Prisma.sql`regexp_replace(p."normalizedName", ${SQL_WORD_SEPARATORS}, ' ', 'g')`;
    const all = searchTextWords();
    const rows = await this.prisma.$queryRaw<
      (PlaceRow & {
        osmType: 'node' | 'way' | 'relation' | null;
        osmId: bigint | null;
        tags: Prisma.JsonValue;
        score: number;
      })[]
    >`
      SELECT * FROM (
        SELECT ${PLACE_COLUMNS}, p."osmType", p."osmId", p.tags,
          CASE
            WHEN ${name} LIKE ${like(words) + '%'} THEN ${w.nameStart}::float8
            ELSE ${w.wordStart}::float8
          END
          + CASE WHEN ${name} = ${words} THEN ${w.exact}::float8 ELSE 0 END
          + ${w.prominence}::float8 * p.prominence / 100.0
          + ${w.hot}::float8 * ln(1 + p.popularity)
          ${proximity} AS score
        FROM places p
        WHERE p."isActive" AND (p.source = 'osm' OR p.popularity > 0)
          ${osmPinsFilter(this.osmPins())}
          AND (${q} <% p."searchText" OR p."searchText" LIKE ${'%' + like(q) + '%'})
          AND ${all} LIKE ${'% ' + like(words) + '%'}
      ) ranked
      ORDER BY score DESC, id
      LIMIT ${OURS_CANDIDATES}`;
    return rows.map((row) => {
      const item = toPlaceItem(row, lang, this.brands);
      return {
        score: row.score,
        item: {
          source: 'place',
          id: item.id,
          name: item.name,
          category: item.category,
          location: item.location,
          isTripinly: item.isTripinly,
          hotCount: item.hotCount,
          prominence: item.prominence,
          type: null,
          address: placeAddress(asStringRecord(row.tags)),
          osmType: row.osmType,
          osmId: row.osmId?.toString() ?? null,
          brand: item.brand,
        },
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
      const osm = this.osmPins() ? 'osm' : 'no-osm';
      return `places:in-view:v${version}:${zoom}:${box}:${categories?.join(',') ?? '*'}:${limit}:${lang}:${osm}`;
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

/** Every name of the place as plain words after a space, for word-start matching. */
function searchTextWords(): Prisma.Sql {
  return Prisma.sql`(' ' || regexp_replace(p."searchText", ${SQL_WORD_SEPARATORS}, ' ', 'g'))`;
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

/**
 * While OSM pins are off (OSM_PINS_ENABLED=false) only our users' places are listed:
 * this leaves OpenStreetMap places out of a query over `places p`.
 */
export function osmPinsFilter(enabled: boolean): Prisma.Sql {
  return enabled ? Prisma.empty : Prisma.sql`AND p.source <> 'osm'`;
}

/** Sights before parks before food and drink. */
export function categoryPriority(): Prisma.Sql {
  return Prisma.sql`CASE
    WHEN p.category IN ('attraction', 'museum', 'historic', 'landmark', 'viewpoint', 'zoo') THEN 0
    WHEN p.category IN ('park', 'nature', 'beach') THEN 1
    ELSE 2 END`;
}

/** "Herrengasse 14, Wien" from a place's OpenStreetMap address tags; null without a street or city. */
export function placeAddress(tags: Record<string, string>): string | null {
  const street = [tags['addr:street'], tags['addr:housenumber']]
    .filter(Boolean)
    .join(' ');
  const parts = [tags['addr:street'] ? street : undefined, tags['addr:city']];
  const address = parts.filter(Boolean).join(', ');
  return address || null;
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

export function toPlaceItem(
  row: PlaceRow,
  lang: string,
  brands: BrandPolicy,
): PlaceItem {
  return {
    id: row.id,
    name: localizedName(row, lang),
    category: row.category,
    location: { lat: row.lat, lng: row.lng },
    isTripinly: row.popularity > 0,
    hotCount: row.popularity,
    prominence: row.prominence,
    coverPhotoId: null,
    coverImageId: null,
    coverSource: null,
    coverThumbUrl: null,
    hotByMe: false,
    brand: brands.present(row.brand),
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
