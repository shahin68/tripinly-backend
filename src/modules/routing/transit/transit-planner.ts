import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';
import type { Env } from '../../../common/config/env';
import { REDIS } from '../../../common/redis/redis.module';
import type { LatLng } from '../geo';
import {
  type TransitItinerary,
  type TransitPlan,
  TransitProvider,
} from './transit.provider';

const MINUTE = 60_000;
const WEEK = 7 * 86_400_000;
/** Timetables are published a few weeks ahead; further out, the same weekday this week stands in. */
const TYPICAL_AFTER = 6 * 86_400_000;

export interface PlannedTrip {
  itinerary: TransitItinerary;
  /** The times come from the same weekday in the current timetable, not the requested date's. */
  typicalTimes: boolean;
}

/**
 * Picks one public transport trip for a time: leaving at `time` (the
 * earliest arrival wins, fewer changes on a tie) or arriving by it (the
 * latest departure wins). Walking wins when it arrives no later. Answers
 * are cached per minute for TRANSIT_CACHE_SECONDS.
 */
@Injectable()
export class TransitPlanner {
  private readonly logger = new Logger(TransitPlanner.name);

  constructor(
    private readonly provider: TransitProvider,
    private readonly config: ConfigService<Env, true>,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /** Null when there is no connection, not even on foot. */
  async trip(input: {
    from: LatLng;
    to: LatLng;
    time: Date;
    arriveBy: boolean;
    timeZone: string;
    now?: Date;
  }): Promise<PlannedTrip | null> {
    const time = new Date(Math.floor(input.time.getTime() / MINUTE) * MINUTE);
    const found = pick(
      await this.cachedPlan({ ...input, time }),
      time,
      input.arriveBy,
    );
    if (found) return { itinerary: found, typicalTimes: false };

    // Past the published timetable (or before it): the same weekday and
    // clock time this week, its times moved back to the requested day.
    const stand = typicalTime(time, input.now ?? new Date(), input.timeZone);
    if (!stand) return null;
    const typical = pick(
      await this.cachedPlan({ ...input, time: stand }),
      stand,
      input.arriveBy,
    );
    return typical
      ? {
          itinerary: shiftItinerary(typical, time.getTime() - stand.getTime()),
          typicalTimes: true,
        }
      : null;
  }

  private async cachedPlan(input: {
    from: LatLng;
    to: LatLng;
    time: Date;
    arriveBy: boolean;
  }): Promise<TransitPlan> {
    const key = `routes:transit:v1:${createHash('sha256')
      .update(
        [
          input.from.lat.toFixed(5),
          input.from.lng.toFixed(5),
          input.to.lat.toFixed(5),
          input.to.lng.toFixed(5),
          input.time.toISOString(),
          input.arriveBy,
        ].join(';'),
      )
      .digest('base64url')}`;
    try {
      const cached = await this.redis.get(key);
      if (cached) return JSON.parse(cached) as TransitPlan;
    } catch {
      // Redis down: uncached.
    }
    const plan = await this.provider.plan(input);
    try {
      await this.redis.set(
        key,
        JSON.stringify(plan),
        'EX',
        this.config.get('TRANSIT_CACHE_SECONDS', { infer: true }),
      );
    } catch (error) {
      this.logger.warn(`Transit cache write failed: ${(error as Error).name}`);
    }
    return plan;
  }
}

/** The trip to show for `time`, or null. */
export function pick(
  plan: TransitPlan,
  time: Date,
  arriveBy: boolean,
): TransitItinerary | null {
  const at = time.getTime();
  const ms = (iso: string) => Date.parse(iso);
  const rides = plan.itineraries.filter((ride) =>
    arriveBy ? ms(ride.arrival) <= at : ms(ride.departure) >= at,
  );
  const best = rides.sort((a, b) =>
    arriveBy
      ? ms(b.departure) - ms(a.departure) || a.transfers - b.transfers
      : ms(a.arrival) - ms(b.arrival) || a.transfers - b.transfers,
  )[0];
  if (!plan.walk) return best ?? null;
  // MOTIS times the walk from the requested time, in whole minutes; the
  // walk's own seconds are exact.
  const walkSeconds = plan.walk.steps.reduce(
    (sum, step) => sum + step.durationSeconds,
    0,
  );
  const walk = shiftItinerary(
    plan.walk,
    (arriveBy ? at - walkSeconds * 1000 : at) - ms(plan.walk.departure),
  );
  if (!best) return walk;
  const walkWins = arriveBy
    ? ms(walk.departure) >= ms(best.departure)
    : ms(walk.arrival) <= ms(best.arrival);
  return walkWins ? walk : best;
}

/**
 * The same weekday and local clock time within the coming week, when `time`
 * is more than six days away from now; null when it is close enough to
 * have its own timetable.
 */
export function typicalTime(
  time: Date,
  now: Date,
  timeZone: string,
): Date | null {
  const diff = time.getTime() - now.getTime();
  if (Math.abs(diff) <= TYPICAL_AFTER) return null;
  const weeks = Math.floor(diff / WEEK);
  const moved = new Date(time.getTime() - weeks * WEEK);
  // Keep the local clock time across a daylight saving change.
  const drift = offsetMinutes(time, timeZone) - offsetMinutes(moved, timeZone);
  return new Date(moved.getTime() + drift * MINUTE);
}

/** Minutes the zone is ahead of UTC at that moment. */
function offsetMinutes(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
  }).formatToParts(at);
  const value = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value);
  const local = Date.UTC(
    value('year'),
    value('month') - 1,
    value('day'),
    value('hour'),
    value('minute'),
  );
  return Math.round(
    (local - Math.floor(at.getTime() / MINUTE) * MINUTE) / MINUTE,
  );
}

export function shiftItinerary(
  itinerary: TransitItinerary,
  deltaMs: number,
): TransitItinerary {
  const shift = (iso: string) =>
    new Date(Date.parse(iso) + deltaMs).toISOString();
  return {
    ...itinerary,
    departure: shift(itinerary.departure),
    arrival: shift(itinerary.arrival),
    steps: itinerary.steps.map((step) => ({
      ...step,
      from: { ...step.from, time: shift(step.from.time) },
      to: { ...step.to, time: shift(step.to.time) },
    })),
  };
}
