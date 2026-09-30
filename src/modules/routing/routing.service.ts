import { createHash } from 'node:crypto';
import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { PrismaService } from '../../common/prisma/prisma.service';
import { REDIS } from '../../common/redis/redis.module';
import { Prisma, type PlaceCategory } from '../../generated/prisma/client';
import { EntitlementService } from '../billing/entitlement.service';
import { PremiumFeature } from '../billing/entitlements';
import { MarkersService } from '../markers/markers.service';
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
  ROUTING_ATTRIBUTION,
  type RouteResponseDto,
} from './routing.dto';

export const MAX_ROUTE_WAYPOINTS = 50;
export const MAX_OPTIMIZE_MARKERS = 25;
const ROUTE_CACHE_TTL_SECONDS = 7 * 86_400;

/** Along-the-way search per mode (10-maps-places-routing.md). */
const ALONG = {
  walking: { bufferMeters: 250, simplifyMeters: 20 },
  cycling: { bufferMeters: 500, simplifyMeters: 20 },
  driving: { bufferMeters: 1500, simplifyMeters: 100 },
} as const satisfies Record<RoutingMode, unknown>;
const ALONG_SEGMENTS = 10;
const ALONG_PER_SEGMENT = 4;
const ALONG_MAX = 40;

/** Speeds for straight-line estimates when routing is unavailable (m/s). */
const STRAIGHT_LINE_SPEED: Record<RoutingMode, number> = {
  walking: 5 / 3.6,
  cycling: 15 / 3.6,
  driving: 40 / 3.6,
};

interface Waypoint extends LatLng {
  markerId: string | null;
}

/**
 * Route lines (day and A→B), places along the way, and best route
 * (routing skill). Route lines are free for everyone; ordering by real
 * travel time needs the best_route_realtime entitlement.
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
  ) {}

  async pointToPoint(
    userId: string,
    input: {
      from: LatLng;
      to: LatLng;
      mode: RoutingMode;
      categories?: PlaceCategory[];
      excludeTripId?: string;
    },
    lang: string,
  ): Promise<RouteResponseDto> {
    if (input.excludeTripId) {
      await this.access.assert(userId, input.excludeTripId, 'view');
    }
    return this.build(
      userId,
      [
        { ...input.from, markerId: null },
        { ...input.to, markerId: null },
      ],
      input.mode,
      input.categories,
      input.excludeTripId,
      lang,
    );
  }

  /** Through the day's markers in their current order. */
  async day(
    userId: string,
    dayId: string,
    mode: RoutingMode,
    categories: PlaceCategory[] | undefined,
    lang: string,
  ): Promise<RouteResponseDto> {
    const { trip } = await this.access.assertForDay(userId, dayId, 'view');
    const markers = await this.dayMarkers(dayId);
    if (markers.length < 2) {
      return {
        route: null,
        alongTheWay: [],
        degraded: false,
        attribution: ROUTING_ATTRIBUTION,
      };
    }
    return this.build(
      userId,
      markers.map((m) => ({ lat: m.lat, lng: m.lng, markerId: m.id })),
      mode,
      categories,
      trip.id,
      lang,
    );
  }

  /**
   * Best order for a day, the first marker fixed. With the entitlement:
   * by openrouteservice travel times, reporting minutes saved; otherwise,
   * or when travel times are unavailable, by straight-line distance.
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
    const premium = await this.entitlements.has(
      userId,
      PremiumFeature.BEST_ROUTE_REALTIME,
    );

    let durations: CostMatrix | null = null;
    let degraded = false;
    if (premium && markers.length > 2) {
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
    const travelTime = premium && !degraded;
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

  private async build(
    userId: string,
    waypoints: Waypoint[],
    mode: RoutingMode,
    categories: PlaceCategory[] | undefined,
    excludeTripId: string | undefined,
    lang: string,
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

    const alongTheWay = await this.alongTheWay(
      userId,
      route,
      mode,
      categories,
      excludeTripId,
      lang,
    );
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
      degraded,
      attribution: ROUTING_ATTRIBUTION,
    };
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
   * (Tripinly places first, then sights), in route order.
   */
  private async alongTheWay(
    userId: string,
    route: ProviderRoute,
    mode: RoutingMode,
    categories: PlaceCategory[] | undefined,
    excludeTripId: string | undefined,
    lang: string,
  ): Promise<AlongTheWayDto[]> {
    const line = route.line.filter(
      (p, i) =>
        i === 0 ||
        p.lat !== route.line[i - 1].lat ||
        p.lng !== route.line[i - 1].lng,
    );
    if (line.length < 2) return [];
    const wkt = `LINESTRING(${line.map((p) => `${p.lng} ${p.lat}`).join(',')})`;
    const { bufferMeters, simplifyMeters } = ALONG[mode];

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
          ${
            excludeTripId
              ? Prisma.sql`AND NOT EXISTS (
                  SELECT 1 FROM markers m WHERE m."placeId" = p.id AND m."tripId" = ${excludeTripId}::uuid)`
              : Prisma.empty
          }
      )
      SELECT id, name, names, category, lat, lng, popularity, distance, frac FROM (
        SELECT near.*, row_number() OVER (
          PARTITION BY least(floor(frac * ${ALONG_SEGMENTS}), ${ALONG_SEGMENTS - 1})
          ORDER BY (popularity > 0) DESC, popularity DESC, priority, id
        ) AS rank_in_segment
        FROM near
      ) spread
      WHERE rank_in_segment <= ${ALONG_PER_SEGMENT}
      ORDER BY frac, id
      LIMIT ${ALONG_MAX}`;

    const items = await this.places.personalize(
      userId,
      rows.map((row) => toPlaceItem(row, lang)),
    );
    return rows.map((row, i) => ({
      place: items[i],
      distanceFromRouteMeters: Math.round(row.distance),
      positionAlongRoute: Math.round(row.frac * 1000) / 1000,
      etaFromStartSeconds: Math.round(row.frac * route.durationSeconds),
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
