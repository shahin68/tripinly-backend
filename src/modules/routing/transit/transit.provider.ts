import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';
import type { Env } from '../../../common/config/env';
import { REDIS } from '../../../common/redis/redis.module';
import { decodePolyline, haversineMeters, type LatLng } from '../geo';
import { RoutingUnavailableError } from '../routing.provider';

export const TRANSIT_VEHICLES = [
  'tram',
  'subway',
  'bus',
  'train',
  'ferry',
  'cable_car',
  'other',
] as const;
export type TransitVehicle = (typeof TRANSIT_VEHICLES)[number];

export interface TransitPlace extends LatLng {
  /** Null at the trip's own start and end. */
  name: string | null;
  time: string;
}

export interface TransitStep {
  kind: 'walk' | 'ride';
  vehicle: TransitVehicle | null;
  line: { name: string; color: string | null; textColor: string | null } | null;
  headsign: string | null;
  from: TransitPlace;
  to: TransitPlace;
  /** Stops passed between getting on and off. */
  stops: number;
  distanceMeters: number;
  durationSeconds: number;
  path: LatLng[];
}

export interface TransitItinerary {
  departure: string;
  arrival: string;
  transfers: number;
  steps: TransitStep[];
}

export interface TransitPlan {
  /** Rides, best first as MOTIS orders them. */
  itineraries: TransitItinerary[];
  /** Walking the whole way, when it is possible. */
  walk: TransitItinerary | null;
}

const MODE_VEHICLES: Record<string, TransitVehicle> = {
  TRAM: 'tram',
  SUBWAY: 'subway',
  METRO: 'subway',
  BUS: 'bus',
  COACH: 'bus',
  RAIL: 'train',
  HIGHSPEED_RAIL: 'train',
  LONG_DISTANCE: 'train',
  NIGHT_RAIL: 'train',
  REGIONAL_FAST_RAIL: 'train',
  REGIONAL_RAIL: 'train',
  SUBURBAN: 'train',
  FERRY: 'ferry',
  FUNICULAR: 'cable_car',
  AERIAL_LIFT: 'cable_car',
  CABLE_CAR: 'cable_car',
};

/**
 * Our MOTIS service ("transit" on Railway's private network), the public
 * transport counterpart of openrouteservice. One retry on 5xx. Calls are
 * counted per UTC day against TRANSIT_DAILY_QUOTA. Logs never contain
 * coordinates.
 */
@Injectable()
export class TransitProvider {
  private readonly logger = new Logger(TransitProvider.name);

  constructor(
    private readonly config: ConfigService<Env, true>,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async plan(input: {
    from: LatLng;
    to: LatLng;
    time: Date;
    arriveBy: boolean;
  }): Promise<TransitPlan> {
    await this.countCall();
    const base = this.config.get('TRANSIT_BASE_URL', { infer: true });
    const query = new URLSearchParams({
      fromPlace: `${input.from.lat},${input.from.lng}`,
      toPlace: `${input.to.lat},${input.to.lng}`,
      time: input.time.toISOString(),
      arriveBy: String(input.arriveBy),
    });
    const url = `${base.replace(/\/+$/, '')}/api/v5/plan?${query}`;
    const timeout = this.config.get('TRANSIT_TIMEOUT_MS', { infer: true });
    for (let attempt = 1; ; attempt++) {
      const started = Date.now();
      let status = 0;
      try {
        const response = await fetch(url, {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(timeout),
        });
        status = response.status;
        if (response.ok) return toPlan((await response.json()) as MotisPlan);
      } catch (error) {
        this.logger.warn(
          `Transit plan failed after ${Date.now() - started} ms: ${error instanceof Error ? error.name : 'unknown error'}`,
        );
        throw new RoutingUnavailableError('failed');
      }
      this.logger.warn(
        `Transit plan answered ${status} after ${Date.now() - started} ms`,
      );
      if (status >= 500 && attempt === 1) continue;
      throw new RoutingUnavailableError('failed');
    }
  }

  private async countCall(): Promise<void> {
    const quota = this.config.get('TRANSIT_DAILY_QUOTA', { infer: true });
    const counter = `transit:calls:${new Date().toISOString().slice(0, 10)}`;
    let used: number;
    try {
      used = await this.redis.incr(counter);
      if (used === 1) await this.redis.expire(counter, 2 * 86_400);
    } catch {
      return;
    }
    if (used > quota) {
      if (used === quota + 1) {
        this.logger.error(
          `Transit daily quota (${quota}) used up; public transport routes answer ROUTING_UNAVAILABLE until 00:00 UTC`,
        );
      }
      throw new RoutingUnavailableError('quota');
    }
    if (used === Math.ceil(quota * 0.8)) {
      this.logger.warn(`Transit at 80% of the daily quota (${quota})`);
    }
  }
}

/** MOTIS /api/v5/plan, only the parts we read. */
export interface MotisPlan {
  direct?: MotisItinerary[];
  itineraries?: MotisItinerary[];
}

interface MotisItinerary {
  startTime: string;
  endTime: string;
  transfers?: number;
  legs: MotisLeg[];
}

interface MotisPlace {
  name?: string;
  lat: number;
  lon: number;
  departure?: string;
  arrival?: string;
  vertexType?: string;
}

interface MotisLeg {
  mode: string;
  from: MotisPlace;
  to: MotisPlace;
  startTime: string;
  endTime: string;
  duration: number;
  distance?: number;
  headsign?: string;
  routeShortName?: string;
  displayName?: string;
  routeColor?: string;
  routeTextColor?: string;
  intermediateStops?: unknown[];
  legGeometry?: { points: string; precision?: number };
}

export function toPlan(body: MotisPlan): TransitPlan {
  const itineraries = (body.itineraries ?? []).map(toItinerary);
  const direct = (body.direct ?? []).find((itinerary) =>
    itinerary.legs.every((leg) => leg.mode === 'WALK'),
  );
  return {
    // A "ride" without a ride (walk only) is the walk below, not a ride.
    itineraries: itineraries.filter((itinerary) =>
      itinerary.steps.some((step) => step.kind === 'ride'),
    ),
    walk: direct ? toItinerary(direct) : null,
  };
}

function toItinerary(itinerary: MotisItinerary): TransitItinerary {
  return {
    departure: iso(itinerary.startTime),
    arrival: iso(itinerary.endTime),
    transfers: itinerary.transfers ?? 0,
    steps: itinerary.legs.map(toStep),
  };
}

function toStep(leg: MotisLeg): TransitStep {
  const walk = leg.mode === 'WALK';
  const path = leg.legGeometry?.points
    ? decodePolyline(leg.legGeometry.points, leg.legGeometry.precision ?? 6)
    : [
        { lat: leg.from.lat, lng: leg.from.lon },
        { lat: leg.to.lat, lng: leg.to.lon },
      ];
  const name = leg.routeShortName || leg.displayName;
  return {
    kind: walk ? 'walk' : 'ride',
    vehicle: walk ? null : (MODE_VEHICLES[leg.mode] ?? 'other'),
    line:
      walk || !name
        ? null
        : {
            name,
            color: hexColor(leg.routeColor),
            textColor: hexColor(leg.routeTextColor),
          },
    headsign: walk ? null : (leg.headsign ?? null),
    from: place(leg.from, leg.startTime),
    to: place(leg.to, leg.endTime),
    stops: walk ? 0 : (leg.intermediateStops?.length ?? 0),
    distanceMeters: Math.round(leg.distance ?? pathMeters(path)),
    durationSeconds: leg.duration,
    path,
  };
}

function place(value: MotisPlace, time: string): TransitPlace {
  // MOTIS names the request's own points START and END.
  const own = value.vertexType === 'NORMAL';
  return {
    name: own || !value.name ? null : value.name,
    lat: value.lat,
    lng: value.lon,
    time: iso(time),
  };
}

/** One format for every time: 2026-11-17T09:44:00.000Z. */
function iso(value: string): string {
  return new Date(value).toISOString();
}

function hexColor(value: string | undefined): string | null {
  return value && /^[0-9a-fA-F]{6}$/.test(value)
    ? `#${value.toUpperCase()}`
    : null;
}

export function pathMeters(path: LatLng[]): number {
  return path
    .slice(1)
    .reduce((sum, point, i) => sum + haversineMeters(path[i], point), 0);
}
