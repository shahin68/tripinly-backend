import { createHash } from 'node:crypto';
import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';
import type { Env } from '../../common/config/env';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { PrismaService } from '../../common/prisma/prisma.service';
import { REDIS } from '../../common/redis/redis.module';
import { Prisma, type PlaceCategory } from '../../generated/prisma/client';
import { EntitlementService } from '../billing/entitlement.service';
import { PremiumFeature } from '../billing/entitlements';
import { MarkersService } from '../markers/markers.service';
import type { CategoryCountDto } from '../places/places.dto';
import {
  categoryPriority,
  PLACE_COLUMNS,
  type PlaceRow,
  PlacesService,
  toPlaceItem,
} from '../places/places.service';
import { TripAccessService } from '../trips/trip-access.service';
import { limitReached } from '../trips/trips.service';
import { encodePolyline, haversineMeters, type LatLng } from './geo';
import { type CostMatrix, optimizeOrder, pathCost } from './route-order';
import {
  type ProviderRoute,
  RoutingProvider,
  type RoutingMode,
  RoutingUnavailableError,
} from './routing.provider';
import {
  type AlongTheWayDto,
  type OptimizeResultDto,
  type RouteLegDto,
  type RouteMode,
  ROUTING_ATTRIBUTION,
  type RouteResponseDto,
  transitAttribution,
  type TransitStepDto,
} from './routing.dto';
import { type PlannedTrip, TransitPlanner } from './transit/transit-planner';
import {
  regionFor,
  TRANSIT_REGIONS,
  type TransitRegion,
  transitCredit,
} from './transit/transit-regions';
import { pathMeters, type TransitStep } from './transit/transit.provider';

export const MAX_ROUTE_WAYPOINTS = 50;
export const MAX_OPTIMIZE_MARKERS = 25;
const ROUTE_CACHE_TTL_SECONDS = 7 * 86_400;

/** Along-the-way search per mode (10-maps-places-routing.md). */
const ALONG = {
  walking: { bufferMeters: 250, simplifyMeters: 20 },
  cycling: { bufferMeters: 500, simplifyMeters: 20 },
  driving: { bufferMeters: 1500, simplifyMeters: 100 },
} as const satisfies Record<RoutingMode, unknown>;
/** Stretches of the route the places along the way are spread over; each takes its share of APP_ALONG_THE_WAY_MAX_PLACES. */
const ALONG_SEGMENTS = 10;
/** Walks shorter than this (changing platforms) get no places along the way. */
const MIN_ALONG_WALK_METERS = 100;

/** Speeds for straight-line estimates when routing is unavailable (m/s). */
const STRAIGHT_LINE_SPEED: Record<RoutingMode, number> = {
  walking: 5 / 3.6,
  cycling: 15 / 3.6,
  driving: 40 / 3.6,
};

interface Waypoint extends LatLng {
  markerId: string | null;
}

/** When a public transport route sets off, or arrives by. */
export interface TransitTime {
  at: Date;
  arriveBy: boolean;
}

/**
 * Route lines (day and A→B), places along the way, and best order
 * (routing skill). Route lines need the routes entitlement (Tripinly Pro);
 * the best order by real travel times is free for everyone.
 */
@Injectable()
export class RoutingService {
  private readonly logger = new Logger(RoutingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TripAccessService,
    private readonly places: PlacesService,
    private readonly provider: RoutingProvider,
    private readonly entitlements: EntitlementService,
    private readonly markers: MarkersService,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly config: ConfigService<Env, true>,
    private readonly transit: TransitPlanner,
  ) {}

  async pointToPoint(
    userId: string,
    input: {
      from: LatLng;
      to: LatLng;
      mode: RouteMode;
      /** transit only; now when omitted. */
      time?: TransitTime;
      categories?: PlaceCategory[];
      excludeTripId?: string;
      /** The places at the route's ends: they are its ends, not places along it. */
      excludePlaceIds?: string[];
    },
    lang: string,
  ): Promise<RouteResponseDto> {
    if (input.excludeTripId) {
      await this.access.assert(userId, input.excludeTripId, 'view');
    }
    await this.assertRoutes(userId);
    const waypoints: Waypoint[] = [
      { ...input.from, markerId: null },
      { ...input.to, markerId: null },
    ];
    if (input.mode === 'transit') {
      return this.buildTransit(
        userId,
        waypoints,
        input.time ?? { at: new Date(), arriveBy: false },
        input.categories,
        input.excludeTripId,
        lang,
        input.excludePlaceIds,
      );
    }
    return this.build(
      userId,
      waypoints,
      input.mode,
      input.categories,
      input.excludeTripId,
      lang,
      input.excludePlaceIds,
    );
  }

  /** Through the day's markers in their current order. */
  async day(
    userId: string,
    dayId: string,
    mode: RouteMode,
    categories: PlaceCategory[] | undefined,
    lang: string,
    /** transit only: the first leg leaves then (now when omitted), each next one when the last arrives. */
    departAt?: Date,
  ): Promise<RouteResponseDto> {
    const { trip } = await this.access.assertForDay(userId, dayId, 'view');
    await this.assertRoutes(userId);
    const markers = await this.dayMarkers(dayId);
    if (markers.length < 2) {
      return {
        route: null,
        alongTheWay: [],
        alongTheWayCounts: [],
        degraded: false,
        attribution:
          mode === 'transit'
            ? transitAttribution(transitCredit(this.transitRegions()))
            : ROUTING_ATTRIBUTION,
      };
    }
    const waypoints = markers.map((m) => ({
      lat: m.lat,
      lng: m.lng,
      markerId: m.id,
    }));
    if (mode === 'transit') {
      return this.buildTransit(
        userId,
        waypoints,
        { at: departAt ?? new Date(), arriveBy: false },
        categories,
        trip.id,
        lang,
      );
    }
    return this.build(userId, waypoints, mode, categories, trip.id, lang);
  }

  /**
   * Best order for a day, the first marker fixed, for everyone: by
   * openrouteservice travel times, reporting minutes saved; by straight-line
   * distance when travel times are unavailable (degraded).
   */
  async optimize(
    userId: string,
    dayId: string,
    mode: RoutingMode,
    apply: boolean,
  ): Promise<OptimizeResultDto> {
    await this.access.assertForDay(
      userId,
      dayId,
      apply ? 'edit_content' : 'view',
    );
    const markers = await this.dayMarkers(dayId);
    if (markers.length > MAX_OPTIMIZE_MARKERS) {
      throw limitReached('optimizeMarkers', MAX_OPTIMIZE_MARKERS);
    }
    let durations: CostMatrix | null = null;
    let degraded = false;
    if (markers.length > 2) {
      try {
        const matrix = await this.provider.matrix(markers, mode);
        // Unreachable pairs: estimate from the straight line.
        durations = matrix.map((row, i) =>
          row.map(
            (value, j) =>
              value ??
              haversineMeters(markers[i], markers[j]) /
                STRAIGHT_LINE_SPEED[mode],
          ),
        );
      } catch (error) {
        if (!(error instanceof RoutingUnavailableError)) throw error;
        degraded = true;
      }
    }
    const cost =
      durations ??
      markers.map((a) => markers.map((b) => haversineMeters(a, b)));
    const order = optimizeOrder(cost);
    const markerIds = order.map((i) => markers[i].id);

    if (apply) await this.markers.reorder(userId, dayId, markerIds);
    const current = [...markers.keys()];
    const travelTime = !degraded;
    return {
      dayId,
      markerIds,
      mode: travelTime ? 'travel_time' : 'straight_line',
      savedMinutes: travelTime
        ? durations
          ? Math.max(
              0,
              Math.round(
                (pathCost(current, cost) - pathCost(order, cost)) / 60,
              ),
            )
          : 0
        : null,
      degraded,
      applied: apply,
    };
  }

  /** Routes are Tripinly Pro (premium-feature skill). */
  private async assertRoutes(userId: string): Promise<void> {
    if (!(await this.entitlements.has(userId, PremiumFeature.ROUTES))) {
      throw new AppException(ErrorCode.PREMIUM_REQUIRED, HttpStatus.FORBIDDEN);
    }
  }

  private async build(
    userId: string,
    waypoints: Waypoint[],
    mode: RoutingMode,
    categories: PlaceCategory[] | undefined,
    excludeTripId: string | undefined,
    lang: string,
    excludePlaceIds: string[] = [],
  ): Promise<RouteResponseDto> {
    let route: ProviderRoute;
    let degraded = false;
    try {
      route = await this.cachedRoute(waypoints, mode);
    } catch (error) {
      if (!(error instanceof RoutingUnavailableError)) throw error;
      if (error.reason === 'failed') {
        throw new AppException(
          ErrorCode.ROUTING_UNAVAILABLE,
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }
      route = straightLine(waypoints, mode);
      degraded = true;
    }

    const [alongTheWay, alongTheWayCounts] = await Promise.all([
      this.alongTheWay(
        userId,
        route.line,
        route.durationSeconds,
        excludePlaceIds,
        mode,
        categories,
        excludeTripId,
        lang,
      ),
      this.alongTheWayCounts(
        [route.line],
        mode,
        excludePlaceIds,
        excludeTripId,
      ),
    ]);
    return {
      route: {
        polyline: encodePolyline(route.line),
        distanceMeters: Math.round(route.distanceMeters),
        durationSeconds: Math.round(route.durationSeconds),
        legs: route.legs.map((leg, i) => ({
          fromMarkerId: waypoints[i].markerId,
          toMarkerId: waypoints[i + 1].markerId,
          distanceMeters: Math.round(leg.distanceMeters),
          durationSeconds: Math.round(leg.durationSeconds),
        })),
      },
      alongTheWay,
      alongTheWayCounts,
      degraded,
      attribution: ROUTING_ATTRIBUTION,
    };
  }

  /**
   * By public transport, leg by leg: each leg leaves when the one before
   * arrives (no stay times; the route is a rough guide). Places along the
   * way only near the walks. A leg with no connection at all is a straight
   * walk estimate and the route is degraded.
   */
  private async buildTransit(
    userId: string,
    waypoints: Waypoint[],
    time: TransitTime,
    categories: PlaceCategory[] | undefined,
    excludeTripId: string | undefined,
    lang: string,
    excludePlaceIds: string[] = [],
  ): Promise<RouteResponseDto> {
    const region = this.config.get('TRANSIT_ENABLED', { infer: true })
      ? regionFor(
          this.config.get('TRANSIT_REGIONS', { infer: true }),
          ...waypoints,
        )
      : undefined;
    if (!region) {
      throw new AppException(
        ErrorCode.TRANSIT_NO_COVERAGE,
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    const pairs = waypoints.slice(1).map((to, i) => [waypoints[i], to]);
    const trips: (PlannedTrip | null)[] = [];
    try {
      if (time.arriveBy) {
        // Only A→B routes arrive by a time: one leg.
        trips.push(await this.transitLeg(pairs[0], time, region));
      } else {
        let at = time.at;
        for (const pair of pairs) {
          const trip = await this.transitLeg(
            pair,
            { at, arriveBy: false },
            region,
          );
          trips.push(trip);
          at = trip
            ? new Date(trip.itinerary.arrival)
            : new Date(at.getTime() + straightWalkSeconds(pair) * 1000);
        }
      }
    } catch (error) {
      if (!(error instanceof RoutingUnavailableError)) throw error;
      throw new AppException(
        ErrorCode.ROUTING_UNAVAILABLE,
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    if (pairs.length === 1 && !trips[0]) {
      throw new AppException(
        ErrorCode.TRANSIT_NO_CONNECTION,
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    // Legs without a connection: a straight walk from when the last one arrived.
    let clock = time.at;
    const legSteps = trips.map((trip, i) => {
      const steps = trip?.itinerary.steps ?? [straightWalk(pairs[i], clock)];
      clock = new Date(steps[steps.length - 1].to.time);
      return steps;
    });
    const steps = legSteps.flat();
    const departure = steps[0].from.time;
    const arrival = steps[steps.length - 1].to.time;
    const durationSeconds =
      (Date.parse(arrival) - Date.parse(departure)) / 1000;
    const distanceMeters = steps.reduce(
      (sum, step) => sum + step.distanceMeters,
      0,
    );

    const [alongTheWay, alongTheWayCounts] = await Promise.all([
      this.transitAlongTheWay(
        userId,
        steps,
        departure,
        durationSeconds,
        excludePlaceIds,
        categories,
        excludeTripId,
        lang,
      ),
      this.alongTheWayCounts(
        alongWalks(steps).map((step) => step.path),
        'walking',
        excludePlaceIds,
        excludeTripId,
      ),
    ]);
    const legs: RouteLegDto[] = legSteps.map((legSteps, i) => ({
      fromMarkerId: pairs[i][0].markerId,
      toMarkerId: pairs[i][1].markerId,
      distanceMeters: legSteps.reduce(
        (sum, step) => sum + step.distanceMeters,
        0,
      ),
      durationSeconds: Math.round(
        (Date.parse(legSteps[legSteps.length - 1].to.time) -
          Date.parse(legSteps[0].from.time)) /
          1000,
      ),
      departure: legSteps[0].from.time,
      arrival: legSteps[legSteps.length - 1].to.time,
      transfers: trips[i]?.itinerary.transfers ?? 0,
      steps: legSteps.map(toStepDto),
    }));
    return {
      route: {
        polyline: encodePolyline(steps.flatMap((step) => step.path)),
        distanceMeters,
        durationSeconds: Math.round(durationSeconds),
        legs,
        departure,
        arrival,
        transfers: legs.reduce((sum, leg) => sum + (leg.transfers ?? 0), 0),
        typicalTimes: trips.some((trip) => trip?.typicalTimes),
      },
      alongTheWay,
      alongTheWayCounts,
      degraded: trips.some((trip) => !trip),
      attribution: transitAttribution(transitCredit([region])),
    };
  }

  private transitLeg(
    [from, to]: Waypoint[],
    time: TransitTime,
    region: TransitRegion,
  ): Promise<PlannedTrip | null> {
    return this.transit.trip({
      from,
      to,
      time: time.at,
      arriveBy: time.arriveBy,
      timeZone: region.timeZone,
    });
  }

  /** Places near the walks only (riders can't stop), in route order. */
  private async transitAlongTheWay(
    userId: string,
    steps: TransitStep[],
    departure: string,
    durationSeconds: number,
    excludePlaceIds: string[],
    categories: PlaceCategory[] | undefined,
    excludeTripId: string | undefined,
    lang: string,
  ): Promise<AlongTheWayDto[]> {
    const total = steps.reduce((sum, step) => sum + step.distanceMeters, 0);
    let before = 0;
    const walks = steps.flatMap((step) => {
      const start = before;
      before += step.distanceMeters;
      return isAlongWalk(step) ? [{ step, start }] : [];
    });
    const found = await Promise.all(
      walks.map(({ step }) =>
        this.alongTheWay(
          userId,
          step.path,
          step.durationSeconds,
          excludePlaceIds,
          'walking',
          categories,
          excludeTripId,
          lang,
        ),
      ),
    );
    const seen = new Set<string>();
    const max = this.config.get('APP_ALONG_THE_WAY_MAX_PLACES', {
      infer: true,
    });
    return found
      .flatMap((items, i) => {
        const { step, start } = walks[i];
        const offset =
          (Date.parse(step.from.time) - Date.parse(departure)) / 1000;
        return items.map((item) => ({
          place: item.place,
          distanceFromRouteMeters: item.distanceFromRouteMeters,
          positionAlongRoute:
            total > 0
              ? Math.round(
                  ((start + item.positionAlongRoute * step.distanceMeters) /
                    total) *
                    1000,
                ) / 1000
              : 0,
          etaFromStartSeconds: Math.min(
            Math.round(durationSeconds),
            Math.round(offset + item.etaFromStartSeconds),
          ),
        }));
      })
      .filter((item) => {
        if (seen.has(item.place.id)) return false;
        seen.add(item.place.id);
        return true;
      })
      .slice(0, max);
  }

  private transitRegions(): TransitRegion[] {
    return this.config
      .get('TRANSIT_REGIONS', { infer: true })
      .map((id) => TRANSIT_REGIONS[id]);
  }

  /**
   * Provider routes cached 7 days by rounded coordinates and mode. A day's
   * key changes whenever its markers do, so edits need no invalidation.
   */
  private async cachedRoute(
    points: LatLng[],
    mode: RoutingMode,
  ): Promise<ProviderRoute> {
    const key = `routes:v1:${mode}:${createHash('sha256')
      .update(
        points.map((p) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`).join(';'),
      )
      .digest('base64url')}`;
    try {
      const cached = await this.redis.get(key);
      if (cached) return JSON.parse(cached) as ProviderRoute;
    } catch {
      // Redis down: route uncached.
    }
    const route = await this.provider.route(points, mode);
    try {
      await this.redis.set(
        key,
        JSON.stringify(route),
        'EX',
        ROUTE_CACHE_TTL_SECONDS,
      );
    } catch (error) {
      this.logger.warn(`Route cache write failed: ${(error as Error).name}`);
    }
    return route;
  }

  /**
   * Listed places near the line, spread over ten stretches of the route
   * (Tripinly places first, then sights), in route order. The places at the
   * route's ends ([excludePlaceIds]) are left out: they are its ends.
   */
  /**
   * How many places of each kind lie along the lines, for the filter chips:
   * the same places alongTheWay picks from, ignoring the asked categories
   * and the per-route cap.
   */
  private async alongTheWayCounts(
    lines: LatLng[][],
    mode: RoutingMode,
    excludePlaceIds: string[],
    excludeTripId: string | undefined,
  ): Promise<CategoryCountDto[]> {
    const parts = lines
      .map((line) =>
        line.filter(
          (p, i) =>
            i === 0 || p.lat !== line[i - 1].lat || p.lng !== line[i - 1].lng,
        ),
      )
      .filter((line) => line.length >= 2);
    if (!parts.length) return [];
    const wkt = `MULTILINESTRING(${parts
      .map((line) => `(${line.map((p) => `${p.lng} ${p.lat}`).join(',')})`)
      .join(',')})`;
    const { bufferMeters, simplifyMeters } = ALONG[mode];
    return this.prisma.$queryRaw<CategoryCountDto[]>`
      WITH line AS (
        SELECT ST_Transform(ST_Simplify(ST_Transform(ST_GeomFromText(${wkt}, 4326), 3857), ${simplifyMeters}), 4326)::geography AS geog
      )
      SELECT p.category, count(*)::int AS count
      FROM places p, line
      WHERE p."isActive" AND (p.source = 'osm' OR p.popularity > 0)
        AND ST_DWithin(p.location, line.geog, ${bufferMeters})
        ${excludePlaceIds.length ? Prisma.sql`AND p.id <> ALL(${excludePlaceIds}::uuid[])` : Prisma.empty}
        ${
          excludeTripId
            ? Prisma.sql`AND NOT EXISTS (
                SELECT 1 FROM markers m WHERE m."placeId" = p.id AND m."tripId" = ${excludeTripId}::uuid)`
            : Prisma.empty
        }
      GROUP BY p.category
      ORDER BY count DESC, p.category`;
  }

  private async alongTheWay(
    userId: string,
    routeLine: LatLng[],
    durationSeconds: number,
    excludePlaceIds: string[],
    mode: RoutingMode,
    categories: PlaceCategory[] | undefined,
    excludeTripId: string | undefined,
    lang: string,
  ): Promise<AlongTheWayDto[]> {
    const line = routeLine.filter(
      (p, i) =>
        i === 0 ||
        p.lat !== routeLine[i - 1].lat ||
        p.lng !== routeLine[i - 1].lng,
    );
    if (line.length < 2) return [];
    const wkt = `LINESTRING(${line.map((p) => `${p.lng} ${p.lat}`).join(',')})`;
    const { bufferMeters, simplifyMeters } = ALONG[mode];
    const max = this.config.get('APP_ALONG_THE_WAY_MAX_PLACES', {
      infer: true,
    });
    const perSegment = Math.ceil(max / ALONG_SEGMENTS);

    const rows = await this.prisma.$queryRaw<
      (PlaceRow & { distance: number; frac: number })[]
    >`
      WITH r AS (
        SELECT ST_Simplify(ST_Transform(ST_GeomFromText(${wkt}, 4326), 3857), ${simplifyMeters}) AS g
      ), line AS (
        SELECT g, ST_Transform(g, 4326)::geography AS geog FROM r
      ), near AS (
        SELECT ${PLACE_COLUMNS},
               ST_Distance(p.location, line.geog) AS distance,
               ST_LineLocatePoint(line.g, ST_Transform(p.location::geometry, 3857)) AS frac,
               ${categoryPriority()} AS priority
        FROM places p, line
        WHERE p."isActive" AND (p.source = 'osm' OR p.popularity > 0)
          AND ST_DWithin(p.location, line.geog, ${bufferMeters})
          ${categories?.length ? Prisma.sql`AND p.category = ANY(${categories}::"PlaceCategory"[])` : Prisma.empty}
          ${excludePlaceIds.length ? Prisma.sql`AND p.id <> ALL(${excludePlaceIds}::uuid[])` : Prisma.empty}
          ${
            excludeTripId
              ? Prisma.sql`AND NOT EXISTS (
                  SELECT 1 FROM markers m WHERE m."placeId" = p.id AND m."tripId" = ${excludeTripId}::uuid)`
              : Prisma.empty
          }
      )
      SELECT id, name, names, category, lat, lng, popularity, prominence, distance, frac FROM (
        SELECT near.*, row_number() OVER (
          PARTITION BY least(floor(frac * ${ALONG_SEGMENTS}), ${ALONG_SEGMENTS - 1})
          ORDER BY (popularity > 0) DESC, popularity DESC, priority, id
        ) AS rank_in_segment
        FROM near
      ) spread
      WHERE rank_in_segment <= ${perSegment}
      ORDER BY frac, id
      LIMIT ${max}`;

    const items = await this.places.personalize(
      userId,
      rows.map((row) => toPlaceItem(row, lang)),
    );
    return rows.map((row, i) => ({
      place: items[i],
      distanceFromRouteMeters: Math.round(row.distance),
      positionAlongRoute: Math.round(row.frac * 1000) / 1000,
      etaFromStartSeconds: Math.round(row.frac * durationSeconds),
    }));
  }

  private dayMarkers(dayId: string) {
    return this.prisma.marker.findMany({
      where: { dayId, hiddenAt: null },
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
      select: { id: true, lat: true, lng: true },
      take: MAX_ROUTE_WAYPOINTS,
    });
  }
}

/** Straight segments between the waypoints, with times from a typical speed. */
function straightLine(points: LatLng[], mode: RoutingMode): ProviderRoute {
  const legs = points.slice(1).map((point, i) => {
    const distanceMeters = haversineMeters(points[i], point);
    return {
      distanceMeters,
      durationSeconds: distanceMeters / STRAIGHT_LINE_SPEED[mode],
    };
  });
  return {
    line: points.map(({ lat, lng }) => ({ lat, lng })),
    distanceMeters: legs.reduce((sum, leg) => sum + leg.distanceMeters, 0),
    durationSeconds: legs.reduce((sum, leg) => sum + leg.durationSeconds, 0),
    legs,
  };
}

/** A straight walk at the estimate speed, for a leg with no connection. */
function straightWalk([from, to]: Waypoint[], at: Date): TransitStep {
  const seconds = straightWalkSeconds([from, to]);
  const path = [
    { lat: from.lat, lng: from.lng },
    { lat: to.lat, lng: to.lng },
  ];
  return {
    kind: 'walk',
    vehicle: null,
    line: null,
    headsign: null,
    from: { name: null, ...path[0], time: at.toISOString() },
    to: {
      name: null,
      ...path[1],
      time: new Date(at.getTime() + seconds * 1000).toISOString(),
    },
    stops: 0,
    distanceMeters: Math.round(pathMeters(path)),
    durationSeconds: seconds,
    path,
  };
}

function straightWalkSeconds([from, to]: LatLng[]): number {
  return Math.round(haversineMeters(from, to) / STRAIGHT_LINE_SPEED.walking);
}

function toStepDto({ path, ...step }: TransitStep): TransitStepDto {
  return { ...step, polyline: encodePolyline(path) };
}

/** Walks long enough for places along the way (changing platforms is not). */
function isAlongWalk(step: TransitStep): boolean {
  return step.kind === 'walk' && step.distanceMeters >= MIN_ALONG_WALK_METERS;
}

function alongWalks(steps: TransitStep[]): TransitStep[] {
  return steps.filter(isAlongWalk);
}
