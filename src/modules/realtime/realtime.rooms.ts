/** Socket.IO namespace for the app (docs/knowledge/05-realtime-and-notifications.md). */
export const REALTIME_NAMESPACE = '/v1/realtime';

export const userRoom = (userId: string): string => `user:${userId}`;
export const tripRoom = (tripId: string): string => `trip:${tripId}`;

/** Events sent to a user's own room. */
export const UserEvents = {
  TRIPS_CHANGED: 'trips.changed',
  NOTIFICATION_CREATED: 'notification.created',
  ACCOUNT_SUSPENDED: 'account.suspended',
} as const;

/** What every realtime event carries on the wire. */
export interface RealtimeMessage<T = unknown> {
  event: string;
  tripId: string | null;
  /** Who caused it; null for system events. */
  actorId: string | null;
  at: string;
  data: T;
}
