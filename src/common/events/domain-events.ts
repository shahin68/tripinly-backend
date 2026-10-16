import { applyDecorators } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

/**
 * Domain events emitted by services after their transaction commits. Realtime
 * and notification modules subscribe; services never call gateways directly.
 * Event names and payloads follow docs/knowledge/05-realtime-and-notifications.md.
 */
export const DomainEvents = {
  TRIP_CREATED: 'trip.created',
  TRIP_UPDATED: 'trip.updated',
  TRIP_DELETED: 'trip.deleted',
  /** Someone asked to join a trip; data `{ requestId, ownerId }`. For the owner's notification, not the trip room. */
  JOIN_REQUESTED: 'join_request.created',
  DAY_CREATED: 'day.created',
  DAY_DELETED: 'day.deleted',
  MARKER_CREATED: 'marker.created',
  MARKER_UPDATED: 'marker.updated',
  MARKER_DELETED: 'marker.deleted',
  MARKERS_REORDERED: 'markers.reordered',
  MARKER_COVER_CHANGED: 'marker.cover_changed',
  PHOTO_PROCESSING: 'photo.processing',
  PHOTO_READY: 'photo.ready',
  PHOTO_FAILED: 'photo.failed',
  PHOTO_DELETED: 'photo.deleted',
  PHOTOS_REORDERED: 'photos.reordered',
  COMMENT_CREATED: 'comment.created',
  COMMENT_DELETED: 'comment.deleted',
  /** Any like or unlike; realtime throttles it per target (see 05-realtime). */
  LIKE_COUNT_CHANGED: 'like.count_changed',
  MEMBER_ADDED: 'member.added',
  MEMBER_REMOVED: 'member.removed',
  USER_BLOCKED: 'user.blocked',
  /** Someone followed a user; data `{ followeeId }`. Not a trip event; no push yet. */
  USER_FOLLOWED: 'user.followed',
  /** Someone stopped following a user; data `{ followeeId }`. Not a trip event. */
  USER_UNFOLLOWED: 'user.unfollowed',
  /** A user was suspended or started account deletion; data `{ userId, reason }`. Not a trip event. */
  ACCOUNT_CLOSED: 'account.closed',
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

/**
 * Listens to several domain events with one handler. (An array passed to
 * @OnEvent is an EventEmitter2 namespace path, not a list of events.)
 */
export function OnDomainEvents(
  ...events: readonly DomainEventName[]
): MethodDecorator {
  return applyDecorators(...events.map((event) => OnEvent(event)));
}
