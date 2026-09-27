---
name: realtime-event
description: Use when adding or changing Tripinly WebSocket (Socket.IO) events, rooms, subscriptions or the gateway, so live updates stay authorized, consistent and documented.
---

# Real-time events

The event catalogue lives in `docs/knowledge/05-realtime-and-notifications.md`. Keep it in sync with the code.

## Adding an event

1. **Emit a domain event from the service** after the DB transaction commits:
   ```ts
   this.events.emit('marker.created', { tripId, actorId, marker });
   ```
   Services never import the gateway.
2. **Map it in the realtime module**: a listener subscribes to the domain event, builds the wire payload and emits to the room:
   ```ts
   { event: 'marker.created', tripId, actorId, at: new Date().toISOString(), data: MarkerDto }
   ```
   Use the same response DTOs as the REST API so clients can reuse models.
3. **Room choice**: trip-wide changes → `trip:{tripId}`; personal things → `user:{userId}`.
4. **Block filtering**: when the actor and a socket's user have a block relation, skip that socket. Use the gateway helper `emitToTripExcludingBlocked(tripId, actorId, payload)`.
5. **Throttle** high-frequency events (like counts) — max one per target per 2 s, sending the latest count.
6. Document the event in the catalogue table (name, when, data).

## Subscriptions and auth

- The handshake verifies the access token. On `trip.subscribe`, run `TripAccessService.assert(userId, tripId, 'view')` before joining; on failure emit `error { code }` and don't join.
- When a trip turns private or a member is removed or blocked, remove sockets that lost `view` from the room (`realtime.evictFromTrip(tripId, userIds)`).
- On `trip.deleted`, emit then clear the room.
- Access token expiry: the server disconnects with `TOKEN_EXPIRED`; the client refreshes and reconnects, then refetches state.

## Scaling

- Use the Redis adapter; never keep per-process state that must be shared.
- Events are fire-and-forget. Correctness comes from REST refetch on reconnect, so don't build features that break if an event is missed.

## Tests

Gateway tests with a real Socket.IO client against the test app: subscription denied for private trip, event received by member, not received by blocked user, eviction after visibility change.
