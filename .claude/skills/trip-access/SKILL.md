---
name: trip-access
description: Use whenever Tripinly code reads or writes trip-scoped data (trips, days, markers, photos, comments, likes, invites, members) to apply visibility, role and block checks correctly.
---

# Trip access checks

All trip-scoped authorization goes through `TripAccessService`. Never re-implement these checks inline.

## Capabilities

| Capability | Owner | Editor | Anyone else (not blocked) |
|---|---|---|---|
| `view` | ✓ | ✓ | only if trip is **public** and not hidden |
| `edit_content` (days, markers, order, photos, cover) | ✓ | ✓ | ✗ |
| `comment`, `like` | ✓ | ✓ | public trips only |
| `manage` (rename, dates, visibility, delete, members, invites) | ✓ | ✗ | ✗ |
| `copy` | ✗ (own trip) | public trips only | public trips only |
| `leave` | ✗ (owner can't leave; delete instead) | ✓ | ✗ |

Block rule: if the caller and the trip owner have a block in either direction, the caller has **no** capabilities — treat the trip as not found.

## API

```ts
// Throws DomainError('NOT_FOUND', 404) when the caller may not know the trip exists,
// DomainError('FORBIDDEN', 403) when they can see it but not do this.
await tripAccess.assert(userId, tripId, 'edit_content');

// For lists: returns a Prisma where-clause fragment limited to what the user may view.
const where = tripAccess.visibleTripsWhere(userId);
```

## Rules of thumb

- Resolve the trip from the child: marker → `marker.tripId`, photo → marker → trip, comment → marker → trip, day → trip. Never accept a `tripId` from the client alongside a child ID and trust it.
- **404 vs 403:** if the caller can't `view`, always 404. If they can view but not perform the action, 403.
- **Hidden content** (`hiddenAt` set by moderation) is invisible to everyone except admins and, for their own content, the author (shown as hidden).
- **Discovery queries** (Explore, Nearby, Popular, search) must additionally filter `visibility = 'public'`, `hiddenAt IS NULL`, and exclude blocked owners — use the shared query helpers in `discovery`, not ad-hoc filters.
- **Visibility change** public → private: in the same transaction mark the change, then enqueue a popularity recompute for affected places, and emit `trip.updated`; the realtime layer removes non-members from the trip room.
- Cache nothing about access across requests except short-lived (≤ 30 s) membership lookups keyed by trip, invalidated on member changes.

## Tests to include

For every trip-scoped endpoint: owner ✓, editor ✓/✗ per table, stranger on public trip, stranger on private trip (404), blocked user (404), hidden content.
