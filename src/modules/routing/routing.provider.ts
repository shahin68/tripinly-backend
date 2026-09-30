import type { LatLng } from './geo';

export const ROUTING_MODES = ['walking', 'cycling', 'driving'] as const;
export type RoutingMode = (typeof ROUTING_MODES)[number];

export interface ProviderRoute {
  line: LatLng[];
  distanceMeters: number;
  durationSeconds: number;
  /** One per pair of consecutive waypoints. */
  legs: { distanceMeters: number; durationSeconds: number }[];
}

/**
 * Why the provider gave no answer. `not_configured` and `quota` fall back to
 * straight lines; `failed` (timeout, 429, 5xx) is ROUTING_UNAVAILABLE.
 */
export type RoutingFailure = 'not_configured' | 'quota' | 'failed';

export class RoutingUnavailableError extends Error {
  constructor(readonly reason: RoutingFailure) {
    super(`routing unavailable: ${reason}`);
    this.name = 'RoutingUnavailableError';
  }
}

/** Routing behind an interface, so openrouteservice can be swapped or self-hosted. */
export abstract class RoutingProvider {
  abstract route(points: LatLng[], mode: RoutingMode): Promise<ProviderRoute>;
  /** Travel durations in seconds; null where no route exists. */
  abstract matrix(
    points: LatLng[],
    mode: RoutingMode,
  ): Promise<(number | null)[][]>;
}
