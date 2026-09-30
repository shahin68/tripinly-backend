# Tripinly — Maps, Places and Routing

This file records the map architecture decided with the product owner. It overrides anything older that mentions Google Places or storing Google place data.

## The stack

| Part | Choice | Runs where | Cost |
|---|---|---|---|
| Map display | **Google Maps SDK** (Android + iOS) with Google's own POI icons **hidden** via map style | Client | Free on mobile |
| Places shown on the map | **Our own `places` table**: Tripinly places (added/liked by users) + **OpenStreetMap POIs imported by us** | Backend (Postgres/PostGIS) | Free |
| Place search (search box) | 1) our `places` table (POIs by name), 2) **Photon** (OSM geocoder) for addresses, streets, cities | Backend proxies both | Free (public Photon at first, self-host later) |
| Routing (route lines, travel times, matrix) | **openrouteservice (ORS)** | Backend calls it | Free plan to start, paid/self-host later |
| Places along a route | PostGIS query on our `places` table against the ORS route line | Backend | Free |
| Premium best route | ORS matrix + our own ordering algorithm (Google Routes only if the product owner decides later) | Backend | Free/low |

## Legal rules (non-negotiable)

1. **Never store Google Maps content**: no Google place IDs, names, coordinates, photos, ratings or route polylines from Google APIs in our database. The client uses Google only to *draw* the map.
2. The client **hides Google POI icons** so users can only tap our places (which we're allowed to store).
3. Our data on a Google map is fine. Google data on a non-Google map is not — we don't do either with Google data.
4. **OpenStreetMap data (ODbL):** we may store and display it forever with the attribution **"© OpenStreetMap contributors"** visible in the app (client shows it on map screens) and in the app's legal/about screen. Don't offer bulk downloads/exports of the places database to the public (that would trigger ODbL share-alike on the database). A user's own data export may include places they used.
5. **ORS / Photon results** are OSM-derived; storing route geometry and search results is allowed with attribution. Respect their API usage limits.
6. Never call the public OSM tile servers, public Nominatim or public Overpass API from production features.

## Places

Two sources in one table (`places.source`):

- `osm` — imported POIs. Categories we import (OSM tag → our `category`):
  - `amenity=cafe` → `cafe`; `amenity=restaurant|fast_food|food_court` → `restaurant`; `amenity=bar|pub|biergarten` → `bar`; `amenity=ice_cream` → `cafe`
  - `tourism=attraction|artwork|viewpoint|zoo|theme_park|aquarium` → `attraction`; `tourism=museum|gallery` → `museum`
  - `historic=*` (castle, monument, memorial, ruins, archaeological_site…) → `historic`
  - `leisure=park|garden|nature_reserve` → `park`; `natural=peak|beach|waterfall` → `nature`
  - `amenity=place_of_worship` with `tourism`/`historic` or `wikidata` → `landmark`
  - Only named features (`name` present). Nodes, ways and relations (use the centroid / point-on-surface for areas).
- `user` — created when a user adds a marker that isn't an existing place (custom pin, address or city from Photon). Custom places are matched later by name + proximity (see `geo-discovery` skill).

Stored per place: `name`, `names` (json of `name:<lang>` for localization), `category`, `location`, `source`, `osmType` + `osmId` (osm only, unique), `tags` (small json subset: website, opening_hours, cuisine, wikidata), `popularity`, `isActive`, `importedAt`.

**Import job** (see `osm-import` skill): initial load for the launch region, then a monthly refresh. Places missing from a new import are marked `isActive = false`, never deleted if markers reference them.

**Launch region:** default **Austria + Hungary**; expand by adding Geofabrik country extracts (open question for the product owner).

## Showing places while browsing the map — `GET /places/in-view`

`?bbox=minLng,minLat,maxLng,maxLat&zoom=15&categories=cafe,attraction&limit=100`

1. **Tripinly places first**: places with `popularity > 0` (from public markers/likes), ranked by popularity, with a flag `isTripinly: true`, `likeCount`, optional cover thumbnail from the most-liked public photo.
2. **Fill with OSM places** (`popularity = 0`) up to `limit`, only when `zoom >= 14`; spread them over the bbox (grid-bucket the bbox into e.g. 6×6 cells and take the top items per cell by a category priority: attraction/museum/historic before cafe/restaurant/bar).
3. At `zoom < 14`, return only Tripinly places, pre-clustered server-side when there are more than `limit`: a grid of up to 8×8 cells, a cell with one place returns the place, others a cluster `{ count, location }` (centre of its places).
4. Reject oversized bboxes relative to zoom: a side longer than `2880 / 2^floor(zoom)` degrees (about eight tiles; 0.18° at zoom 14) → 400 `BBOX_TOO_LARGE` with `details.maxSpanDegrees`.
5. Filters: categories, blocked owners' content excluded from Tripinly popularity previews, hidden content excluded.
6. Cache results per (bbox widened to a quarter-tile grid, zoom, categories, limit, language) in Redis for 60 s. The key carries a version bumped by every OSM import.

Response: `{ "places": [ … ], "clusters": [ { "count": 37, "location": { … } } ], "attribution": "© OpenStreetMap contributors" }`. Places and clusters are separate arrays (instead of one mixed list) so the generated Kotlin client gets plain types.

**Which places are listed:** OSM places and places with `popularity > 0`. Other user places (custom pins, maybe from private trips) never appear in in-view, search, nearby or popular; they are visible only to people who can see a marker at them.

The old `/places/popular` endpoint becomes a thin variant of this (Tripinly places only, excluding a trip's own places).

## Search — `GET /places/search?q=&lat=&lng=`

- Query our `places` (pg_trgm similarity on `name`/`names`, category-aware, biased by distance to `lat/lng` if given) **and** Photon (`/api?q=&lat=&lon=&lang=`) in parallel.
- Our places match on `searchText` (normalized name + all `name:<lang>` variants) with trigram word similarity, plus a small popularity boost and a proximity boost when `lat/lng` are given; 10 results.
- Photon: `limit=8`, 2 s timeout, `lang` only for en/de/fr (Photon has no other languages; Hungarian gets local names). Failure or timeout → our places only.
- Merge: our places first (`source: "place"`, with IDs and popularity); Photon results returned as `{ source: "photon", id: null, name, location, type, address, osmType, osmId }`, dropping those whose OSM ids are already in our results. `address` is street, city and country, for telling results apart.
- If the user picks a Photon result, the client sends its name + location (+ osm ids) when creating the marker; the backend matches or creates the place.
- Lat/lng used only for ranking; not stored or logged.
- Rate limit per user. Debounce is the client's job (≥ 300 ms, ≥ 2 chars).

## Routing — openrouteservice

Profiles: `foot-walking` (default), `driving-car`, `cycling-regular`. Transit isn't available in ORS (open question if ever needed).

### `GET /routes?from=lat,lng&to=lat,lng&mode=walking&categories=…`
and
### `GET /days/{id}/route?mode=walking&categories=…`
(route through the day's markers in their current order; requires `view` on the trip)

Returns:
```json
{
  "route": { "polyline": "<encoded polyline, precision 5>", "distanceMeters": 3200, "durationSeconds": 2400,
             "legs": [ { "fromMarkerId": "…", "toMarkerId": "…", "distanceMeters": 800, "durationSeconds": 600 } ] },
  "alongTheWay": [ { "place": { … }, "distanceFromRouteMeters": 80, "positionAlongRoute": 0.42, "etaFromStartSeconds": 1000 } ],
  "attribution": "© openrouteservice.org | © OpenStreetMap contributors"
}
```

**Along-the-way query** (PostGIS):
- Buffer by mode: walking 250 m, cycling 500 m, driving 1500 m (configurable).
- Simplify the route line first for long routes (`ST_Simplify` in a metric projection, tolerance ~20 m walking / 100 m driving).
- `ST_DWithin(place.location, routeLine, buffer)`, active places only, requested categories.
- Spread results: split the route into N segments by `ST_LineLocatePoint` fraction (e.g. 10) and take the top K per segment (Tripinly places by popularity first, then OSM by category priority). Default total ≤ 40.
- Exclude places already in the day/trip.
- Order by `positionAlongRoute`.

**Caching:** provider routes cached by (ordered coordinates rounded to 5 decimals, mode) in Redis for 7 days. A day's key changes whenever its markers move, are added, removed or reordered, so no explicit invalidation is needed. `alongTheWay` is recomputed on every request (one indexed query) because it is personalized (covers, likedByMe).

**Free vs premium:**
- Showing a route line for a day, and along-the-way places: **free for everyone** (ORS cost is low). If ORS quota becomes a problem, fall back to straight segments between markers for free users and tell the product owner.
- **Best route (reorder a day):** free = straight-line ordering (no provider call); premium = ORS matrix (`/v2/matrix/{profile}`, durations) + our ordering (nearest neighbour + 2-opt, first marker fixed) + `savedMinutes`.
- Limits: ≤ 25 markers per optimization, ≤ 50 waypoints per day route.
- Anyone who can see the trip may ask for a proposal; saving it (`apply=true`) needs owner or editor.

**Resilience:** ORS timeouts (5 s), 429s and 5xx (retried once) → `ROUTING_UNAVAILABLE` (503) for route requests; the optimize endpoint falls back to straight-line with `mode: "straight_line"` and `degraded: true`.

**Quota:** ORS calls are counted per UTC day in Redis (`ORS_DIRECTIONS_DAILY_QUOTA`, default 2000; `ORS_MATRIX_DAILY_QUOTA`, default 500, the free plan). A warning is logged at 80%; past 100% (or with no `ORS_API_KEY`) route requests return straight segments between the points with `degraded: true` and times from typical speeds (5, 15, 40 km/h), and optimize falls back to straight line. Report quota exhaustion to the product owner.

## Nearby (unchanged idea, new data)

`GET /places/nearby` ranks Tripinly places by `popularity / (1 + km)^1.2`, cursor-paginated; if the first page ends with fewer than 10, it is filled up to `limit` with OSM attractions, museums, historic sites and landmarks by distance. Location not stored or logged (query strings are stripped from request logs).

## Popular spots

`GET /places/popular?bbox=&excludeTripId=` lists Tripinly places in the bbox by popularity (bbox side ≤ 5°, no zoom), leaving out places already used in `excludeTripId`, which the caller must be able to view.
