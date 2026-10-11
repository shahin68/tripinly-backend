/**
 * Defaults accepted by the product owner (docs/knowledge/02-domain-rules.md).
 * Members per trip is APP_TRIP_MAX_MEMBERS, set on Railway.
 */
export const TripLimits = {
  DAYS_PER_TRIP: 20,
  MARKERS_PER_DAY: 50,
  TRIPS_PER_USER: 200,
  ACTIVE_INVITES_PER_TRIP: 20,
} as const;

/** Most usernames one request may carry; guards request size, not the member cap. */
export const MAX_USERNAMES_PER_REQUEST = 200;
