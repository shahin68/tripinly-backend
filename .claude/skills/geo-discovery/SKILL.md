---
name: geo-discovery
description: Use for Tripinly place features — place matching when markers are created, place popularity, in-view map places, search (our places + Photon), Nearby, Popular spots, Explore ranking and PostGIS queries.
---

# Geo and discovery

Read `docs/knowledge/10-maps-places-routing.md` first. Places come only from our DB (OSM imports + user-created). **No Google data, ever.**

## Place matching (marker create/update, copy, add-to-trip)

Inside the marker transaction:

1. `placeId` given → load it (must be active); use it.
2. `osmType` + `osmId` given (from a Photon result) → find by those; else create a `user`-source place carrying the OSM ids, name and location.
3. Else (custom pin) → find an active place within **30 m** with equal `normalizedName` (lowercase, trimmed, diacritics removed, whitespace collapsed):
   ```sql
   SELECT id FROM places
   WHERE "normalizedName" = $1 AND "isActive"
     AND ST_DWithin(location, ST_MakePoint($lng, $lat)::geography, 30)
   ORDER BY location <-> ST_MakePoint($lng, $lat)::geography
   LIMIT 1;
   ```
4. Else create a `user` place (category `other` unless the client sends one).

Reject any field that looks like a Google place ID (`ChIJ…` / `googlePlaceId`) with `VALIDATION_FAILED`.

## Popularity

- `places.popularity` = likes on markers at the place **whose trip is public and not hidden** + direct likes on the place.
- Update incrementally on like/unlike of qualifying markers and places.
- Recompute affected places when: trip visibility changes, trip/marker deleted or hidden, marker moved to another place, account deleted.
- Nightly full recompute to fix drift.

## In-view — `GET /places/in-view`

Follow the algorithm in `10-maps-places-routing.md` (Tripinly places first; OSM fill at zoom ≥ 14, notable-only (Wikidata) at zoom 10–13 while hot spots are few, spread over map-fixed cells by category priority; server clusters per map tile at low zoom; bbox size limit → `BBOX_TOO_LARGE`; 60 s Redis cache per rounded tile).

Response item:
```json
{ "id": "…", "name": "…", "category": "cafe", "location": {"lat":…, "lng":…},
  "isTripinly": true, "likeCount": 1200, "coverThumbUrl": "…|null", "likedByMe": false }
```
or `{ "cluster": true, "count": 37, "location": {…} }`. Include `"attribution": "© OpenStreetMap contributors"` at the top level.

Localized `name`: pick `names["name:<Accept-Language>"]` if present, else `name`.

## Search — `GET /places/search`

Parallel: pg_trgm similarity on our places (active only, boosted by popularity and proximity to `lat/lng`) + Photon (`${PHOTON_BASE_URL}/api?q=&lat=&lon=&lang=&limit=8`, 2 s timeout). Merge ours first, drop Photon items whose OSM id already exists in our results. Photon failure → return ours only (never fail the request). Don't log `q` with coordinates.

## Nearby — `GET /places/nearby`

- Radius default 5 km, max 50 km. Coordinates used only for the query: **not stored, not logged, not in error details**.
- Rank Tripinly places by `popularity / (1 + distance_km)^1.2`; if fewer than 10, top up with OSM attractions/museums/historic by distance.
- Exclude hidden content and blocked users' previews. Cursor-paginate by score, id.

## Popular spots — `GET /places/popular`

Tripinly places only (popularity > 0) in the bbox, ordered by popularity, limit 20, excluding places used in `excludeTripId` (caller must be able to view that trip).

## Explore — `GET /explore/trips`

Public, not hidden, not own, owner not blocked either way. Score `(likeCount + 2 * copyCount) / (ageDays + 2)^1.5`, ties by `createdAt` desc.

## Performance

- GiST on `places.location` (plus partial index where popularity > 0), `markers.location`; GIN trigram on `normalizedName`.
- Use `geography` and `ST_DWithin` (index-friendly); never `ST_Distance` in `WHERE`.
- `ST_MakePoint(lng, lat)` — longitude first.
- Bbox: `location && ST_MakeEnvelope(minLng, minLat, maxLng, maxLat, 4326)::geography`.

## Tests

Matching (placeId, OSM ids, proximity+name, new), Google-ID rejection, in-view ordering and zoom rules, clustering, bbox limit, search merge and Photon outage, nearby top-up, private/hidden/blocked exclusion from popularity and previews.
