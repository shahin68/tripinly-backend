import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';
import type { Env } from '../../common/config/env';
import { REDIS } from '../../common/redis/redis.module';
import type { LatLng } from './geo';
import {
  type ProviderRoute,
  RoutingProvider,
  type RoutingMode,
  RoutingUnavailableError,
} from './routing.provider';

const TIMEOUT_MS = 5_000;
const PROFILES: Record<RoutingMode, string> = {
  walking: 'foot-walking',
  cycling: 'cycling-regular',
  driving: 'driving-car',
};

type Kind = 'directions' | 'matrix';

/**
 * openrouteservice (routing skill). Coordinates go out as [lng, lat]. One
 * retry on 5xx, none on 429. Calls are counted per UTC day against the plan
 * quota; past it, callers fall back to straight lines. Logs never contain
 * coordinates.
 */
@Injectable()
export class OrsProvider extends RoutingProvider {
  private readonly logger = new Logger(OrsProvider.name);

  constructor(
    private readonly config: ConfigService<Env, true>,
    @Inject(REDIS) private readonly redis: Redis,
  ) {
    super();
  }

  async route(points: LatLng[], mode: RoutingMode): Promise<ProviderRoute> {
    const body = await this.call(
      'directions',
      `/v2/directions/${PROFILES[mode]}/geojson`,
      {
        coordinates: points.map((p) => [p.lng, p.lat]),
        // Snap markers to the nearest road however far (parks, squares, peaks).
        radiuses: points.map(() => -1),
      },
    );
    const feature = (body as OrsDirections).features?.[0];
    const coordinates = feature?.geometry?.coordinates;
    if (!feature || !Array.isArray(coordinates)) {
      throw new RoutingUnavailableError('failed');
    }
    const summary = feature.properties?.summary ?? {};
    const segments = feature.properties?.segments ?? [];
    return {
      line: coordinates.map(([lng, lat]) => ({ lat, lng })),
      distanceMeters: summary.distance ?? 0,
      durationSeconds: summary.duration ?? 0,
      legs: points.slice(1).map((_, i) => ({
        distanceMeters: segments[i]?.distance ?? 0,
        durationSeconds: segments[i]?.duration ?? 0,
      })),
    };
  }

  async matrix(
    points: LatLng[],
    mode: RoutingMode,
  ): Promise<(number | null)[][]> {
    const body = await this.call('matrix', `/v2/matrix/${PROFILES[mode]}`, {
      locations: points.map((p) => [p.lng, p.lat]),
      metrics: ['duration'],
    });
    const durations = (body as { durations?: unknown }).durations;
    if (!Array.isArray(durations) || durations.length !== points.length) {
      throw new RoutingUnavailableError('failed');
    }
    return durations as (number | null)[][];
  }

  private async call(
    kind: Kind,
    path: string,
    payload: unknown,
  ): Promise<unknown> {
    const key = this.config.get('ORS_API_KEY', { infer: true });
    if (!key) throw new RoutingUnavailableError('not_configured');
    await this.countCall(kind);

    // Appended, not resolved: the base carries a path (`/openrouteservice`)
    // that `new URL('/v2/…', base)` would drop.
    const base = this.config.get('ORS_BASE_URL', { infer: true });
    const url = `${base.replace(/\/+$/, '')}${path}`;
    for (let attempt = 1; ; attempt++) {
      const started = Date.now();
      let status = 0;
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: key,
            'Content-Type': 'application/json',
            Accept: 'application/json, application/geo+json',
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        status = response.status;
        if (response.ok) return await response.json();
      } catch (error) {
        this.logger.warn(
          `ORS ${kind} failed after ${Date.now() - started} ms: ${error instanceof Error ? error.name : 'unknown error'}`,
        );
        throw new RoutingUnavailableError('failed');
      }
      this.logger.warn(
        `ORS ${kind} answered ${status} after ${Date.now() - started} ms`,
      );
      if (status >= 500 && attempt === 1) continue;
      throw new RoutingUnavailableError('failed');
    }
  }

  /** Counts today's calls; refuses once the daily quota is used up. */
  private async countCall(kind: Kind): Promise<void> {
    const quota =
      kind === 'directions'
        ? this.config.get('ORS_DIRECTIONS_DAILY_QUOTA', { infer: true })
        : this.config.get('ORS_MATRIX_DAILY_QUOTA', { infer: true });
    const counter = `ors:calls:${kind}:${new Date().toISOString().slice(0, 10)}`;
    let used: number;
    try {
      used = await this.redis.incr(counter);
      if (used === 1) await this.redis.expire(counter, 2 * 86_400);
    } catch {
      // Without Redis the quota can't be tracked; let the call through.
      return;
    }
    if (used > quota) {
      if (used === quota + 1) {
        this.logger.error(
          `ORS ${kind} daily quota (${quota}) used up; falling back to straight lines until 00:00 UTC`,
        );
      }
      throw new RoutingUnavailableError('quota');
    }
    if (used === Math.ceil(quota * 0.8)) {
      this.logger.warn(`ORS ${kind} at 80% of the daily quota (${quota})`);
    }
  }
}

interface OrsDirections {
  features?: {
    geometry?: { coordinates?: [number, number][] };
    properties?: {
      summary?: { distance?: number; duration?: number };
      segments?: { distance?: number; duration?: number }[];
    };
  }[];
}
