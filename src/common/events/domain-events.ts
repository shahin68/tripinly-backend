/**
 * Domain events emitted by services after their transaction commits. Realtime
 * and notification modules subscribe; services never call gateways directly.
 * Event names and payloads follow docs/knowledge/05-realtime-and-notifications.md.
 */
export const DomainEvents = {
  TRIP_CREATED: 'trip.created',
  TRIP_UPDATED: 'trip.updated',
  TRIP_DELETED: 'trip.deleted',
  DAY_CREATED: 'day.created',
  DAY_DELETED: 'day.deleted',
  MARKER_CREATED: 'marker.created',
  MARKER_UPDATED: 'marker.updated',
  MARKER_DELETED: 'marker.deleted',
  MARKERS_REORDERED: 'markers.reordered',
  MEMBER_ADDED: 'member.added',
  MEMBER_REMOVED: 'member.removed',
  USER_BLOCKED: 'user.blocked',
} as const;

export type DomainEventName = (typeof DomainEvents)[keyof typeof DomainEvents];

export interface DomainEvent<T = Record<string, unknown>> {
  event: DomainEventName;
  tripId?: string;
  actorId: string;
  at: string;
  data: T;
}

export function domainEvent<T>(
  event: DomainEventName,
  actorId: string,
  data: T,
  tripId?: string,
): DomainEvent<T> {
  return { event, tripId, actorId, at: new Date().toISOString(), data };
}
