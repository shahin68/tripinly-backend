---
name: routing
description: Use for Tripinly routes — openrouteservice integration, route lines between points or through a day's markers, places along the way, best-route optimization (straight-line free, ORS matrix premium), caching and fallbacks.
---

# Routing

Design and response shapes: `docs/knowledge/10-maps-places-routing.md`. Provider: **openrouteservice** behind a `RoutingProvider` interface (so it can be swapped or self-hosted later).

## RoutingProvider interface

```ts
interface RoutingProvider {
  route(points: LatLng[], mode: Mode): Promise<{ line: LatLng[]; distanceMeters: number; durationSeconds: number;
                                                 legs: { distanceMeters: number; durationSeconds: number }[] }>;
  matrix(points: LatLng[], mode: Mode): Promise<{ durations: number[][] }>;
}
```
ORS implementation: `POST {ORS_BASE_URL}/v2/directions/{profile}/geojson` and `POST {ORS_BASE_URL}/v2/matrix/{profile}` (`metrics: ["duration"]`), profiles `foot-walking`, `cycling-regular`, `driving-car`. Note ORS takes `[lng, lat]`. Timeout 5 s, one retry on 5xx, no retry on 429. Log provider latency and status, never coordinates. `ORS_BASE_URL` defaults to `https://api.heigit.org/openrouteservice` (api.openrouteservice.org was shut down 2026-08-24); it has a path, so append paths to it rather than resolving them with `new URL(path, base)`.

## Endpoints

- `GET /routes?from&to&mode&categories` — two points.
- `GET /days/{id}/route?mode&categories` — the day's markers in order (requires `view`; ≤ 50 waypoints).

Both return `route` (encoded polyline precision 5, distance, duration, legs), `alongTheWay`, `attribution`.

## Along the way (PostGIS)

```sql
WITH r AS (
  SELECT ST_Simplify(ST_Transform(ST_SetSRID(ST_GeomFromText($routeWkt), 4326), 3857), $tol) AS g3857
), seg AS (
  SELECT p.*, 
         ST_Distance(ST_Transform(p.location::geometry, 3857), r.g3857) AS dist_m_approx,
         ST_LineLocatePoint(r.g3857, ST_Transform(p.location::geometry, 3857)) AS frac
  FROM places p, r
  WHERE p."isActive"
    AND p.category = ANY($categories)
    AND ST_DWithin(p.location, ST_Transform(r.g3857, 4326)::geography, $bufferMeters)
)
SELECT * FROM (
  SELECT *, row_number() OVER (PARTITION BY floor(frac * $segments)
                               ORDER BY (popularity > 0) DESC, popularity DESC, category_priority(category)) AS rn
  FROM seg
) t WHERE rn <= $perSegment
ORDER BY frac;
```
- Buffers: walking 250 m, cycling 500 m, driving 1500 m. Tolerance: 20 m walking/cycling, 100 m driving. Defaults `segments = 10`, `perSegment = 4`.
- Exclude places already in the trip (`excludeTripId`) and hidden/blocked previews.
- `etaFromStartSeconds ≈ frac × route duration`.
- Web Mercator distances are approximate (fine for ranking); use geography for the `ST_DWithin` filter.

## Caching and invalidation

- Route by hash of (rounded coordinates, mode) → Redis 7 days.
- Along-the-way by (route hash, categories, excludeTripId) → 10 min.
- On marker create/move/reorder/delete, delete the day's cached route key.

## Best route — `POST /days/{id}/optimize`

- Requires `edit_content` to apply; ≤ 25 markers; first marker fixed as start.
- **Free** (no entitlement): straight-line (haversine) distances → nearest neighbour + 2-opt → `mode: "straight_line"`, no `savedMinutes`.
- **Premium** (`EntitlementService.has(user, 'best_route_realtime')`): ORS matrix durations → same algorithm → `mode: "travel_time"`, `savedMinutes` = current order duration − new order duration (rounded, ≥ 0).
- ORS failure on premium → straight-line with `degraded: true`.
- `?apply=true` writes positions in one transaction, emits `markers.reordered`, invalidates the day route cache.

## Quotas

Track ORS calls per day in Redis; at 80% of the plan quota log a warning; at 100% switch day routes to straight segments (`degraded: true`) and tell the product owner in your report — never silently disable.

## Tests

Provider mocked: route/along-the-way response shape, buffer by mode, segment spreading, exclusion of trip places, cache hit and invalidation, optimize free vs premium, degraded fallback, 25-marker limit, access checks.
