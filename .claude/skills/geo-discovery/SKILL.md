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

- `places.popularity` = the place's hot count (`hotCount`; stops have none of their own, their flame marks the place; stored as likes of type `place`). A `user` place counts them only while a visible stop of a public, visible trip is on it, else 0 (`popularity.ts`).
- Recompute on every hot mark/unmark, and for user places when: trip visibility changes, a stop is created, copied, moved, deleted or hidden, a trip or day is deleted or hidden, an account is deleted (`userPlaceIds`).
- Nightly full recompute to fix drift.

## In-view — `GET /places/in-view`

Follow the algorithm in `10-maps-places-routing.md` (places with at least `APP_PLACE_RANK_MIN_HOT_COUNT` likes first, by popularity; then a fill of the places below it at zoom ≥ 14, well-known only (prominence ≥ 60) at zoom 10–13 while hot spots are few; well-known places always by prominence alone so a place shown at one zoom stays at closer zooms, the rest spread over map-fixed cells by category priority, most prominent first; every Place carries `prominence`; server clusters per map tile at low zoom; bbox size limit → `BBOX_TOO_LARGE`; 60 s Redis cache per rounded tile).

Response item:
```json
{ "id": "…", "name": "…", "category": "cafe", "location": {"lat":…, "lng":…},
  "isTripinly": true, "hotCount": 1200, "coverPhotoId": "uuid|null", "coverThumbUrl": "…|null", "hotByMe": false }
```
or `{ "cluster": true, "count": 37, "location": {…} }`. Include `"attribution": "© OpenStreetMap contributors"` at the top level.

Place covers (and so pin photos) and detail photos come only from place photos and public trip photos with at least `APP_PLACE_PHOTO_PIN_MIN_LIKES` likes from people other than the uploader (`PlaceCoversService.representativePhotos`, rule in `02-domain-rules.md`); never pick a place image by marker likes or `popularity`. Without such a photo the cover is the place's first `ready` Commons image (`place_images`, rank order; `coverSource: commons`). Commons images come only from the worker's sync (`PlaceImagesService`, rules in `10-maps-places-routing.md` "Place images"); never hotlink Commons or show a file whose licence the filter in `commons-metadata.ts` refused.

## Map squares — `GET /places/tiles`

`?tiles=z/x/y,…` (1–16 squares, deduplicated) plus in-view's `zoom`, `categories`, `limit`. Parse each square with `parseTile` (degree grid, side `360/2^z`), check `maxSpanForZoom`, answer each square through the same `placesIn` path as in-view (shared cache), and personalize all places in one go. Never a second ranking path.

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

Public, not hidden, at least one visible marker, owner active and not blocked either way; the caller's own trips unless `includeMine=false`. Ranked by likes only, never saves: `likeCount` for `period=all` and `season` (start or end month in the current meteorological season), likes rows of the last 7/30/365 days for `week`/`month`/`year`. `lat`+`lng` adds `ST_DWithin` on the trip's markers with `APP_EXPLORE_NEARBY_RADIUS_KM`; never store or log the point. Ties by `createdAt` desc; the cursor carries the reference time.

## Performance

- GiST on `places.location` (plus partial index where popularity > 0), `markers.location`; GIN trigram on `normalizedName`.
- Use `geography` and `ST_DWithin` (index-friendly); never `ST_Distance` in `WHERE`.
- `ST_MakePoint(lng, lat)` — longitude first.
- Bbox: `location && ST_MakeEnvelope(minLng, minLat, maxLng, maxLat, 4326)::geography`.

## Tests

Matching (placeId, OSM ids, proximity+name, new), Google-ID rejection, in-view ordering and zoom rules, clustering, bbox limit, search merge and Photon outage, nearby top-up, private/hidden/blocked exclusion from popularity and previews.
