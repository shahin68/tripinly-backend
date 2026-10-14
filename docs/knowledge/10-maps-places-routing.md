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
4. **OpenStreetMap data (ODbL):** we may store and display it forever with the attribution **"© OpenStreetMap contributors"** visible in the app (client shows it on map screens) and in the app's legal/about screen. Our `places` table, enriched with QRank and prominence, is an ODbL **Derivative Database**, and the app uses it publicly. ODbL 4.6 then asks us to offer either that database or the method that made it; we offer the method (4.6(b)): `docs/legal/places-database-method.md`, to be published at a public URL before launch. Don't offer bulk downloads/exports of the places database to the public. A user's own data export may include places they used.
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
- **A tap on the map** (`POST /days/{id}/markers` with `location` only) is named on the server: one of our public places (OSM, or liked on a public trip) within 25 m is linked; else Photon `/reverse` (100 m) gives the address and its OSM ids; else the stop is named by its coordinates. One request from the app, no Google data, the point isn't logged.

Stored per place: `name`, `names` (json of `name:<lang>` for localization), `category`, `location`, `source`, `osmType` + `osmId` (osm only, unique), `tags` (small json subset: website, opening_hours, cuisine, wikidata, wikipedia, wikimedia_commons, image), `popularity`, `prominence`, `qrank`, `imageTagsHash`, `isActive`, `importedAt`.

**Prominence** (how well known a place is, 0–100) is set by every import as `round(100 × max(Pq, Pt))`:
- `Pq = min(1, log10(1 + QRank) / 6)`. QRank ranks Wikidata items by a year of Wikimedia page views (CC0, no attribution asked; downloaded from `QRANK_URL`, qrank.toolforge.org, a Wikimedia service, not OSM infrastructure). It joins on the `wikidata` tag; with several items (`Q1;Q2`) the best known counts. When QRank can't be read, places keep the ranks they have.
- `Pt`, from OSM tags, at most 0.5: UNESCO `heritage=1` +0.4, a `wikipedia` tag +0.2, `tourism=attraction` +0.1, a castle, palace, monastery or cathedral +0.2, +0.02 per `name:<lang>` up to 0.1. Stolpersteine, plaques, wayside shrines and crosses, boundary stones and milestones are 0. A `wikidata` tag alone counts for nothing: every listed monument has one.
- A place's score is `popularity + (prominence / 10) × 10 / (10 + popularity)`: the open rank is worth at most 10 likes and halves at 10 real likes, and a new like never lowers it. The map fill (places below `APP_PLACE_RANK_MIN_LIKES` likes) ranks by prominence; photo pins (place-photos plan, planned) will use the full score. Places at or above `APP_PLACE_RANK_MIN_LIKES` rank by popularity, ahead of all others: our likes lead, QRank is the fallback.
- `user` places that carry OSM ids (from Photon) get the kept tags, prominence and QRank from the import too, never a new name, popularity or id.

**Import job** (see `osm-import` skill): initial load for the launch region, then a monthly refresh. Places missing from a new import are marked `isActive = false`, never deleted if markers reference them.

**Launch region:** default **Austria + Hungary**; expand by adding Geofabrik country extracts (open question for the product owner).

## Showing places while browsing the map — `GET /places/in-view`

`?bbox=minLng,minLat,maxLng,maxLat&zoom=15&categories=cafe,attraction&limit=100`

1. **Tripinly places first**: places with at least `APP_PLACE_RANK_MIN_LIKES` likes (`popularity`, from public markers/likes; default 1, Shahin 2026-10-13), ranked by popularity, ahead of every place below it whatever its prominence, with a flag `isTripinly: true`, `likeCount`, optional cover (`coverPhotoId`, `coverThumbUrl`): the public trip photo there with the most **outside likes**, shown only when at least `APP_PLACE_PHOTO_MIN_OUTSIDE_LIKES` (default 2) people liked it who are not its uploader, the trip owner or a member of that trip. Place detail `photoThumbUrls` follows the same rule. `popularity` and `likeCount` are not affected by this rule.
2. **Fill with the places below `APP_PLACE_RANK_MIN_LIKES`** (OSM places, and liked user places when the minimum is above 1) up to `limit`, only when `zoom >= 14`: well-known places (prominence ≥ 60) first, the most prominent first; then the rest spread over cells fixed on the map (a quarter of a map tile at the zoom, anchored at 0°/0°, so panning keeps the same picks), taking the top items per cell by a category priority: attraction/museum/historic before cafe/restaurant/bar, the most prominent first.
3. At `zoom < 14`, return Tripinly places, pre-clustered server-side when there are more than `limit`: one cell per map tile at the zoom (fixed on the map), a cell with one place returns the place, others a cluster `{ count, location }` (centre of its places). While they fit in `limit` and `zoom >= 10`, well-known OSM places (prominence ≥ 60, about 4,000 page views a year) fill up to `limit`, the most prominent first.
   **A place stays once shown (Shahin, 2026-10-13):** well-known places are ordered by prominence alone (ties by id), never spread per cell, so a map square's top places are also the top places of the smaller squares inside it: zooming in only adds places, it never drops a well-known one. Every place carries `prominence`; the app sizes pins by it (thresholds from `/app-config`).
4. Reject oversized bboxes relative to zoom: a side longer than `2880 / 2^floor(zoom)` degrees (about eight tiles; 0.18° at zoom 14) → 400 `BBOX_TOO_LARGE` with `details.maxSpanDegrees`.
5. Filters: categories, blocked owners' content excluded from Tripinly popularity previews, hidden content excluded.
6. Cache results per (bbox widened to a quarter-tile grid, zoom, categories, limit, language) in Redis for 60 s. The key carries a version bumped by every OSM import.

Response: `{ "places": [ … ], "clusters": [ { "count": 37, "location": { … } } ], "attribution": "© OpenStreetMap contributors" }`. Places and clusters are separate arrays (instead of one mixed list) so the generated Kotlin client gets plain types.

**Which places are listed:** OSM places and places with `popularity > 0`. Other user places (custom pins, maybe from private trips) never appear in in-view, search, nearby or popular; they are visible only to people who can see a marker at them.

**Loading by map square — `GET /places/tiles`:** the app loads places per fixed map square (`z/x/y`, side `360 / 2^z` degrees, at `z = floor(zoom) − 2`) instead of per view, keeps the squares it has, and prefetches the ring of squares around the view when the camera stops. One request carries up to 16 squares; each square's answer is the in-view answer for its bbox (same picks, clusters and cache), so moving the map only fetches squares it hasn't seen.

The old `/places/popular` endpoint becomes a thin variant of this (Tripinly places only, excluding a trip's own places).

## Search — `GET /places/search?q=&lat=&lng=&scope=`

- Query our `places` (pg_trgm similarity on `name`/`names`, category-aware, biased by distance to `lat/lng` if given) **and** Photon (`/api?q=&lat=&lon=&lang=`) in parallel.
- Our places match on `searchText` (normalized name + all `name:<lang>` variants) with trigram word similarity, plus a small popularity boost and a proximity boost when `lat/lng` are given; 10 results. A one-letter query skips our places (trigrams need two characters) and returns Photon's prefix matches only.
- Photon: `limit=8`, 4 s timeout, `lang` only for en/de/fr (Photon has no other languages; Hungarian gets local names). A network error or a 5xx is retried once; a timeout, a 4xx (rate limit) or a second failure → our places only, and the log says which (`Photon search failed: TimeoutError` / `HTTP 429` …). Destination search has only Photon, so it comes back empty then. The public komoot instance has no uptime promise: self-host Photon before launch (Shahin, 2026-10-14).
- Merge: our places first (`source: "place"`, with IDs and popularity); Photon results returned as `{ source: "photon", id: null, name, location, type, address, osmType, osmId }`, dropping those whose OSM ids are already in our results. `address` is street, city and country, for telling results apart.
- If the user picks a Photon result, the client sends its name + location (+ osm ids) when creating the marker; the backend matches or creates the place.
- Lat/lng used only for ranking; not stored or logged.
- `scope=destination` (a trip's destination): Photon only, restricted to its area layers (`layer=country,state,county,city,district`, so no addresses, streets, POIs or farms), in Photon's importance order with countries, regions and cities ahead of counties and districts. The same name within 30 km appears once (Vienna the city, not also the state). Our places are skipped.
- Rate limit per user. Debounce is the client's job (≥ 300 ms, ≥ 2 chars).

## Routing — openrouteservice

Host: `https://api.heigit.org/openrouteservice` (`ORS_BASE_URL`; api.openrouteservice.org was shut down on 2026-08-24, and the same keys work on the new host). Profiles: `foot-walking` (default), `driving-car`, `cycling-regular`. Transit isn't available in ORS (open question if ever needed).

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
