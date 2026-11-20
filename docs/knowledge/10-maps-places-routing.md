# Tripinly — Maps, Places and Routing

This file records the map architecture decided with the product owner. It overrides anything older that mentions Google Places or storing Google place data.

## The stack

| Part                                        | Choice                                                                                                     | Runs where                 | Cost                                           |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------- | ---------------------------------------------- |
| Map display                                 | **Google Maps SDK** (Android + iOS) with Google's own POI icons **hidden** via map style                   | Client                     | Free on mobile                                 |
| Places shown on the map                     | **Our own `places` table**: Tripinly places (added/liked by users) + **OpenStreetMap POIs imported by us** | Backend (Postgres/PostGIS) | Free                                           |
| Place search (search box)                   | 1) our `places` table (POIs by name), 2) **Photon** (OSM geocoder) for addresses, streets, cities          | Backend proxies both       | Free (public Photon at first, self-host later) |
| Routing (route lines, travel times, matrix) | **openrouteservice (ORS)**                                                                                 | Backend calls it           | Free plan to start, paid/self-host later       |
| Places along a route                        | PostGIS query on our `places` table against the ORS route line                                             | Backend                    | Free                                           |
| Best order (free)                           | ORS matrix + our own ordering algorithm (Google Routes only if the product owner decides later)            | Backend                    | Free/low                                       |

## Legal rules (non-negotiable)

1. **Never store Google Maps content**: no Google place IDs, names, coordinates, photos, ratings or route polylines from Google APIs in our database. The client uses Google only to _draw_ the map.
2. The client **hides Google POI icons** so users can only tap our places (which we're allowed to store).
3. Our data on a Google map is fine. Google data on a non-Google map is not — we don't do either with Google data.
4. **OpenStreetMap data (ODbL):** we may store and display it forever with the attribution **"© OpenStreetMap contributors"** visible in the app (client shows it on map screens) and in the app's legal/about screen. Our `places` table, enriched with QRank and prominence, is an ODbL **Derivative Database**, and the app uses it publicly. ODbL 4.6 then asks us to offer either that database or the method that made it; we offer the method (4.6(b)): `docs/legal/places-database-method.md`, to be published at a public URL before launch. Don't offer bulk downloads/exports of the places database to the public. A user's own data export may include places they used.
5. **ORS / Photon results** are OSM-derived; storing route geometry and search results is allowed with attribution. Respect their API usage limits.
6. Never call the public OSM tile servers, public Nominatim or public Overpass API from production features.
7. **Wikimedia Commons images** are shown only under their own licences, with a credit under each image: `© author · licence · Wikimedia Commons` (the title first for CC licences before 4.0, `· cropped` where the app crops; public domain: `author · Public domain`). The author links to the file page, the licence to its URL. Map pins credit on tap (the card shows the full credit) and the map shows "Images: Wikimedia Commons, tap for credits" next to the OSM attribution. The About screen says "Some images from Wikimedia Commons under their own licences; Wikimedia Commons is a trademark of the Wikimedia Foundation; Tripinly is not endorsed by it".

## Places

Two sources in one table (`places.source`):

- `osm` — imported POIs. Categories we import (OSM tag → our `category`; first match wins, in this order; 38 categories since 2026-11-15, the list is ours and OSM only maps into it):
  - `amenity=cafe|ice_cream`, `shop=coffee` → `cafe`; `shop=bakery|pastry|confectionery` → `bakery`; `amenity=restaurant|food_court` → `restaurant`; `amenity=fast_food` → `fast_food`; `amenity=nightclub` → `nightlife`; `amenity=bar|pub|biergarten` → `bar`; `craft=winery` → `winery`
  - `tourism=viewpoint` → `viewpoint`; `tourism=zoo|aquarium` → `zoo`; `tourism=attraction|theme_park` → `attraction`; `tourism=museum|gallery` → `museum`
  - `historic=*` (castle, monument, memorial, ruins, archaeological_site…) → `historic`
  - `leisure=park|garden` → `park`; `natural=beach` → `beach`; `natural=peak|waterfall`, `leisure=nature_reserve` → `nature`
  - `amenity=cinema` → `cinema`; `amenity=theatre|arts_centre`, `tourism=artwork` → `entertainment` (app label "Culture & fun")
  - `shop=mall|department_store` → `shopping`; `shop=clothes|shoes|boutique|jewelry|bag|watches|fashion_accessories|cosmetics|perfumery` → `shopping` only with a `brand`, `brand:wikidata` or `wikidata` tag (brand stores like Zara or Gucci, not every small boutique; Shahin, 2026-11-20); `amenity=marketplace` → `market`; `shop=supermarket|convenience|greengrocer` → `groceries`
  - `tourism=hotel|hostel|guest_house` → `stay`; `tourism=camp_site|caravan_site` → `camping`
  - `amenity=doctors|clinic|dentist|hospital` → `health`; `amenity=pharmacy` → `pharmacy`
  - `leisure=sports_centre|stadium|fitness_centre|swimming_pool|golf_course` (not `access=private|members`) → `sports`; `amenity=public_bath`, `leisure=sauna` → `spa`; `leisure=playground|water_park` (not private) → `kids`; `amenity=library` → `library`
  - `railway=station`, `aeroway=aerodrome` with an `iata` code, `amenity=ferry_terminal|bus_station` → `transport`
  - `amenity=place_of_worship` with `tourism`/`historic` or `wikidata` → `landmark`
  - `other` is the catch-all, shown in the apps as **Spot**: never imported, it is what people pick (or keep, as the default) for a spot that fits nowhere else. The wire value stays `other`.
  - **Ours only, never imported** (OSM has millions of them and they would crowd the map; Shahin 2026-11-15): `parking`, `fuel` ("Fuel & charging"), `money` ("ATM & bank"), `toilets`, `rental` (cars, bikes), `photo_spot` ("Photo spot") and `romantic` ("Romantic spot", kiss and love places). People pick them for their own spots.
  - No user-made categories and no label field: a spot is found by its name or its category.
  - Google's Places type names for each category are kept in the client canvas only as a naming reference so later filters mean what people know from Maps; no Google data is used.
  - Only named features (`name` present). Nodes, ways and relations (use the centroid / point-on-surface for areas).
- `user` — created when a user adds a marker that isn't an existing place (custom pin, address or city from Photon). Custom places are matched later by name + proximity (see `geo-discovery` skill).
- **A tap on the map** (`POST /days/{id}/markers` with `location` only) is named on the server: one of our public places (OSM, or liked on a public trip) within 25 m is linked; else Photon `/reverse` (100 m) gives the address and its OSM ids; else the stop is named by its coordinates. One request from the app, no Google data, the point isn't logged.

Stored per place: `brandId` (see Brands below), `name`, `names` (json of `name:<lang>` for localization), `category`, `location`, `source`, `osmType` + `osmId` (osm only, unique), `tags` (small json subset: website, opening_hours, cuisine, brand, brand:wikidata (for brand logos), wikidata, wikipedia, wikimedia_commons, image, addr:street, addr:housenumber, addr:city — the address tells search results with the same name apart), `popularity`, `prominence`, `qrank`, `imageTagsHash`, `isActive`, `importedAt`.

**Prominence** (how well known a place is, 0–100) is set by every import as `round(100 × max(Pq, Pt))`:

- `Pq = min(1, log10(1 + QRank) / 6)`. QRank ranks Wikidata items by a year of Wikimedia page views (CC0, no attribution asked; downloaded from `QRANK_URL`, qrank.toolforge.org, a Wikimedia service, not OSM infrastructure). It joins on the `wikidata` tag; with several items (`Q1;Q2`) the best known counts. When QRank can't be read, places keep the ranks they have.
- `Pt`, from OSM tags, at most 0.5: UNESCO `heritage=1` +0.4, a `wikipedia` tag +0.2, `tourism=attraction` +0.1, a castle, palace, monastery or cathedral +0.2, +0.02 per `name:<lang>` up to 0.1. Stolpersteine, plaques, wayside shrines and crosses, boundary stones and milestones are 0. A `wikidata` tag alone counts for nothing: every listed monument has one.
- A place's score is `popularity + (prominence / 10) × 10 / (10 + popularity)`: the open rank is worth at most 10 likes and halves at 10 real likes, and a new like never lowers it. The map fill (places below `APP_PLACE_RANK_MIN_HOT_COUNT` likes) ranks by prominence; photo pins follow the pin order, liked places first. Places at or above `APP_PLACE_RANK_MIN_HOT_COUNT` rank by popularity, ahead of all others: our likes lead, QRank is the fallback.
- `user` places that carry OSM ids (from Photon) get the kept tags, prominence and QRank from the import too, never a new name, popularity or id.

**Place images** (place-photos plan PR 3): a place's card and pin image is its best photo that may represent it (a place's photo, or a photo on a stop there in a public trip, that at least `APP_PLACE_PHOTO_PIN_MIN_LIKES` (3) people other than its uploader liked (the trip's owner and members count); rule in `02-domain-rules.md`), else its most liked Wikimedia Commons image (Commons order on a tie). The app draws it inside the pin of a place with prominence ≥ `photoPinMinProminence` (90) or ≥ `photoPinMinHotCount` (3) likes, at most `mapMaxPhotoPins` (100) at once (`GET /app-config`).

- Commons files come from the place's own OSM links, in order: the Wikidata main image (P18, through the `wikidata` tag; never P154 logo or P948 banner), `wikimedia_commons=File:…`, then `image=` when it points to a Commons file. At most 3 per place; `Category:` links and other hosts are ignored.
- Only free licences pass: CC0, public domain, CC BY and CC BY-SA 1.0–4.0 with country ports. Refused: non-free, unknown or GFDL-only licences, files with restrictions or a deletion request, SVG, TIFF, GIF and files under 640 px on their longest edge.
- The worker (queue `place-images`, one job at a time, only with `PLACE_IMAGES_SYNC_ENABLED` and storage) syncs the places whose image tags changed since its last run (`places.imagesSyncedHash`) daily and once on every worker start, and rechecks every stored image weekly: deleted or relicensed files are removed with their copies, changed files downloaded again, credits refreshed. It calls the Wikidata and Commons APIs about once a second with the User-Agent `TripinlyPlaceImages/1.0 (tripinly@gmail.com)`, honours 429/maxlag `Retry-After`, and downloads only the API's 1280 px thumbnails from Wikimedia's file hosts (`upload.wikimedia.org`, and `thumb.wikimedia.org`, where Commons has served thumbnails since October 2026).
- Copies, never hotlinks: a 256 px square thumb and a display copy at most 1280 px wide, WebP, without GPS or camera data, with the credit and licence written back as XMP. The app gets signed URLs like trip photos, so users' devices never contact Wikimedia.
- People can report a Commons image (`place_image`); an admin can only hide it, and hidden images stay hidden through every sync.
- People can like a Commons image (`PUT /likes/place_image/{id}`, Shahin 2026-10-18). It shows in the place's Photos list after people's photos, and its likes order the place's Commons images (the cover too, when no photo qualifies). It stays one row: nothing is copied. Its likes don't move the place's popularity and notify no one.

**Brands** (Shahin, 2026-11-20): brand stores (Zara, KFC, McDonald's) show the brand's logo on a rounded-square pin; every other place keeps the round pin.

- Our `brands` table is the source of truth: our own id, `name`, `wikidataId` (unique, optional) and a logo. Each import adds a brand for every new `brand:wikidata` it meets (the first id when OSM lists several), named by the `brand` tag or else the place's name, and never renames it afterwards. It then ties the extract's OSM places to their brand (`places.brandId`), and unties them when the tag is gone. Admins add brands without Wikidata (`POST /admin/brands`).
- People can't add brands. When adding their own spot they can say "This is a brand store" and pick one from `GET /brands?q=` (word starts, brands with the most places first); the new user place gets `brandId`. A stop that joins an existing place ignores it. An admin unties a wrong one (`PUT /admin/places/{id}/brand`).
- Logos come from two places, ours first: a logo an admin uploads (`PUT /admin/brands/{id}/logo`) always wins and is never replaced; otherwise the worker's daily place-images job (same Wikimedia pace, after the images) reads the brand's Wikidata logo (P154) from Commons for up to 200 brands a run that have an active place, most places first, each again a month later. Only public domain or CC0 files (no credit needed on a pin) without restrictions other than "trademarked", PNG, JPEG, WebP or SVG.
- Every logo is put on white, cut to the logo itself and fitted into a 96 px square WebP with a small white margin (q82, q55 above 8 KB), a few KB. A white logo on transparency, which would vanish on the pin's white tile, is dropped. The bytes are kept on the brand row (no storage objects) and served at `GET /brands/{id}/logo/{hash}`: public, cached forever, the hash changes with the logo.
- Places carry `brand { id, name, logoUrl }` (null without a brand) in in-view, tiles, search, nearby, popular, around, along the way and details. `logoUrl` is a path on the API, null when the brand has no logo or it doesn't show: **`BRAND_LOGOS_ENABLED`** (api, default false) turns all logos on (staging on; production only after the lawyer has reviewed trademark logo use), and **`BRAND_LOGOS_HIDDEN`** (api, comma list of brand names or Wikidata ids, any case) hides single brands. A switch change shows on the map once the in-view cache expires. A brand without a shown logo keeps its name; its pin stays round.

**Import job** (see `osm-import` skill): initial load for the launch region, then a monthly refresh. Places missing from a new import are marked `isActive = false`, never deleted if markers reference them.

**Launch region:** default **Austria + Hungary**; expand by adding Geofabrik country extracts (open question for the product owner).

## Showing places while browsing the map — `GET /places/in-view`

`?bbox=minLng,minLat,maxLng,maxLat&zoom=15&categories=cafe,attraction&limit=100`

1. **Tripinly places first**: places with a `hotCount` of at least `APP_PLACE_RANK_MIN_HOT_COUNT` (`popularity`, the place's hot marks; default 1, Shahin 2026-10-13), ranked by popularity, ahead of every place below it whatever its prominence, with a flag `isTripinly: true`, `hotCount`, optional cover (`coverPhotoId`, `coverThumbUrl`): the most liked of a place's photo, or a photo on a stop there in a public trip, that at least `APP_PLACE_PHOTO_PIN_MIN_LIKES` (3) people other than its uploader liked (the trip's owner and members count). Place detail `images` (and the older `photoThumbUrls`) follow the same rule. Without such a photo the cover is the place's most liked Commons image (`coverSource: commons`, see Place images). `popularity` and `hotCount` are not affected by this rule.
2. **Fill with the places below `APP_PLACE_RANK_MIN_HOT_COUNT`** (OSM places, and liked user places when the minimum is above 1) up to `limit`, only when `zoom >= 14`: well-known places (prominence ≥ 60) first, the most prominent first; then the rest spread over cells fixed on the map (a quarter of a map tile at the zoom, anchored at 0°/0°, so panning keeps the same picks), taking the top items per cell by a category priority: attraction/museum/historic before cafe/restaurant/bar, the most prominent first.
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
- Our places match on `searchText` (normalized name + all `name:<lang>` variants) only when the name, or a word in one of its names, starts with the query's words ("zara" finds Zara and Zara Home, not Dr. Zarza or Café Zartl; Shahin, 2026-11-20). Trigrams and a substring check only narrow the rows first (index). A one-letter query skips our places (trigrams need two characters) and returns Photon's prefix matches only.
- **One score, one list (Shahin, 2026-11-19; `search-ranking.ts`, same numbers in the SQL):** how the name matches first (the name starts with the query 1.0, a word in it, in any language, starts with it 0.75; exactly the name +0.25), then how well known it is (`0.6 × prominence / 100 + 0.15 × ln(1 + hot count)`), then a gentle nearness to `lat/lng` (`0.3 / (1 + km / 5)`). So "Steph" in Vienna gives Stephansdom and Stephansplatz before Franz-Stephan-Denkmal, and a far famous place beats a nearby unknown one with the same start. Photon results get the same text score (0.3 for an area or address Photon found another way; a Photon place whose name doesn't match is dropped) plus their type (country, city 0.8, state 0.7, county, district 0.4, locality 0.3, street, other 0.1, house 0) times the text score, so an area rises only when its name matches, and the same nearness. A query with a house number as its own word ("Graben 12") adds 1.0 to houses and streets, so addresses come first only then. Both lists are sorted together (ours first on ties) and cut to 10. Weights are constants in code, not env vars.
- **The map's city only (Shahin, 2026-11-20):** with `lat/lng` the backend looks up the city the map centre is in (Photon: the nearest address within 2 km names its city, the city by that name nearest the centre gives its `extent`), in parallel with the search. Our places (best 40 first) and Photon's places, streets and addresses outside that box are dropped; cities, regions and countries stay from anywhere, so the map can still go to another city. The box comes back as `city` `{ west, south, east, north }` and the app frames results only inside it, leaving the camera alone when there are none. No city found (no address near, Photon down, no extent) → `city: null`, no limit. Not cached: the map centre isn't stored anywhere.
- The map searched by name (in-view / tiles with `q`) uses the same word-start rule, so the pins match the list.
- Photon: `limit=12`, 4 s timeout, `lang` only for en/de/fr (Photon has no other languages; Hungarian gets local names). A network error or a 5xx is retried once; a timeout, a 4xx (rate limit) or a second failure → our places only, and the log says which (`Photon search failed: TimeoutError` / `HTTP 429` …). Destination search has only Photon, so it comes back empty then. The public komoot instance has no uptime promise: self-host Photon before launch (Shahin, 2026-10-14).
- Merge: one list by the score above (`source: "place"`, with IDs, `hotCount` and `prominence`); Photon results returned as `{ source: "photon", id: null, name, location, type, address, osmType, osmId }`, dropping those whose OSM ids are already in our results. `address` is street, city and country, for telling results apart.
- If the user picks a Photon result, the client sends its name + location (+ osm ids) when creating the marker; the backend matches or creates the place.
- Lat/lng used only for ranking; not stored or logged.
- `scope=destination` (a trip's destination): Photon only, restricted to its area layers (`layer=country,state,county,city,district`, so no addresses, streets, POIs or farms), in Photon's importance order with countries, regions and cities ahead of counties and districts. The same name within 30 km appears once (Vienna the city, not also the state). Our places are skipped.
- Rate limit per user. Debounce is the client's job (≥ 300 ms, ≥ 2 chars).

## Routing — openrouteservice

Host: `https://api.heigit.org/openrouteservice` (`ORS_BASE_URL`; api.openrouteservice.org was shut down on 2026-08-24, and the same keys work on the new host). Profiles: `foot-walking` (default), `driving-car`, `cycling-regular`. ORS has no public transport: `mode=transit` goes to our MOTIS service instead (see "Public transport" below).

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
- Spread results: split the route into N segments by `ST_LineLocatePoint` fraction (e.g. 10) and take the top K per segment (Tripinly places by popularity first, then OSM by category priority). At most `APP_ALONG_THE_WAY_MAX_PLACES` in total (api, default 40, 10–200), each of the 10 stretches taking a tenth of it, rounded up (2026-11-10).
- Exclude places already in the day/trip.
- Exclude the places at an A→B route's ends by id (`fromPlaceId`, `toPlaceId`): they are its ends, not places along the way (Shahin, 2026-11-13). A day route's markers and an A→B route's `excludeTripId` already leave the trip's own places out by id.
- Order by `positionAlongRoute`.
- `alongTheWayCounts`: how many places of each kind lie along the route (same buffer and exclusions, ignoring `categories` and the cap), most first, for the app's filter chips; transit counts along the walks only (2026-11-17).

**Caching:** provider routes cached by (ordered coordinates rounded to 5 decimals, mode) in Redis for 7 days. A day's key changes whenever its markers move, are added, removed or reordered, so no explicit invalidation is needed. `alongTheWay` is recomputed on every request (one indexed query) because it is personalized (covers, likedByMe).

**Free vs premium:**

- Route lines (a day's route and A→B) with along-the-way places: **Tripinly Pro** (entitlement `routes`; 403 `PREMIUM_REQUIRED` otherwise). Without Pro the app joins the day's stops with its own curved direction lines (no server call). (Product owner, 2026-10-18.)
- **Best order (reorder a day):** **free for everyone**, a simple reordering: ORS matrix (`/v2/matrix/{profile}`, durations) + our ordering (nearest neighbour + 2-opt, first marker fixed) + `savedMinutes`; straight-line distances with `degraded: true` when travel times are unavailable.
- Limits: ≤ 25 markers per optimization, ≤ 50 waypoints per day route.
- Anyone who can see the trip may ask for a proposal; saving it (`apply=true`) needs owner or editor.

**Resilience:** ORS timeouts (5 s), 429s and 5xx (retried once) → `ROUTING_UNAVAILABLE` (503) for route requests; the optimize endpoint falls back to straight-line with `mode: "straight_line"` and `degraded: true`.

**Quota:** ORS calls are counted per UTC day in Redis (`ORS_DIRECTIONS_DAILY_QUOTA`, default 2000; `ORS_MATRIX_DAILY_QUOTA`, default 500, the free plan). A warning is logged at 80%; past 100% (or with no `ORS_API_KEY`) route requests return straight segments between the points with `degraded: true` and times from typical speeds (5, 15, 40 km/h), and optimize falls back to straight line. Report quota exhaustion to the product owner.

## Public transport — our MOTIS service (2026-11-15)

`mode=transit` on `GET /routes` and `GET /days/{id}/route` routes by tram, U-Bahn, train and bus. Decided with Shahin on 2026-11-15 (decision log #122, canvas https://claude.ai/artifact/N8XVYsaTJ7U4ZdcrnNYgXL).

**Engine:** [MOTIS](https://github.com/motis-project/motis) 2.11.4, self-hosted (not Google: its terms forbid storing or mixing results, so along the way and Pro gating would break, and it costs per request; not public MOTIS instances: no uptime promise). Measured for Vienna: build 18 s, 1.5 GB RAM while building, a 263 MB package (65 MB compressed), ~270 MB RAM serving, answers in 20–45 ms (`/mnt/project-files/reviews/2026-11-15-transit-spike.md`).

**Two Railway services** from `docker/transit.Dockerfile`, no volume, no GitHub Actions (setup: `docs/deploy/transit.md`):

- **transit** (private network only): downloads the newest package from R2 (`transit/current.json` → `transit/packages/<time>.tar.gz`), starts MOTIS on it and answers on `$PORT` (8080). Health `/api/v1/health` is 503 until MOTIS is ready, so a redeploy switches over without downtime. It never builds.
- **transit-builder** (Railway cron, daily, any hour): downloads each city's GTFS feeds (conditional GET, then sha256). Builds only when a feed changed, the cities changed, or the streets are 30 days old; then cuts each city's streets from its Geofabrik extract (`osmium extract --strategy complete_ways`: a clipped extract has ways pointing outside it, which MOTIS refuses), runs `motis import` (street routing and footpaths on, map tiles and geocoding off), uploads the package, keeps the previous one for a rollback, and redeploys **transit** through Railway's API (`RAILWAY_API_TOKEN`). Rebuilds never touch the live service, so a city with a midday "night" elsewhere in the world doesn't matter.

**Cities:** one recipe per city in `src/modules/routing/transit/transit-regions.ts` (id, name, covered box, time zone, feeds with licence and credit, Geofabrik extract). Vienna first: Wiener Linien GTFS (Wiener Linien and Wiener Lokalbahnen), CC BY 4.0, credit "Wiener Linien, Datenquelle: Stadt Wien – data.wien.gv.at" (to check once more before launch). A new city = a recipe in the repo, then its id in `TRANSIT_REGIONS` on api and transit-builder (builder first, so its package is live before the apps see the area). Transitous' feed list is the source for new cities' feeds.

**Switches:** `TRANSIT_ENABLED` (api, default false) and `TRANSIT_REGIONS` (default `vienna`). `GET /app-config` sends `transitAreas[]` `{ id, name, south, west, north, east }`, empty while switched off. The app dims the tram button where either end is outside every area; a tap shows a short note in the card ("Public transport isn't available here yet"), never an error banner. The server answers 422 `TRANSIT_NO_COVERAGE` there anyway (no call to MOTIS).

**Times** (Shahin, 2026-11-15): no start or stay times, never asking people when they go. `departAt` (ISO) leaves then, default now; the app sends the open trip day (when it is ahead) at the current clock time and its "Leave at HH:mm" picker changes only the time on that day. `arriveBy` (A→B only, not with `departAt`) arrives by that time instead. A day route's first leg leaves at `departAt`, each next leg when the one before arrives.

**Picking a trip:** leaving at a time, the earliest arrival wins (fewer changes on a tie); arriving by a time, the latest departure. Walking the whole way wins when it arrives no later (it is one walk step). A date more than six days away (past the published timetable) uses the same weekday and local clock time this week and says `typicalTimes: true`.

**Answer:** the same `RouteResponseDto`, with `route.departure`, `route.arrival`, `route.transfers`, `route.typicalTimes`, and per leg `departure`, `arrival`, `transfers`, `steps[]`. A step is `{ kind: walk|ride, vehicle (tram, subway, bus, train, ferry, cable_car, other; null on foot), line { name, color, textColor } (the feed's own colours as #RRGGBB, e.g. U2 #A862A4; null on foot), headsign, from, to ({ name (null at the route's own ends), lat, lng, time }), stops (passed between getting on and off), distanceMeters, durationSeconds, polyline }`. Polylines are precision 5 like every route (MOTIS's precision 6 is converted). The app draws rides in their line colour as plain solid lines and walks dotted, and lists the steps in their own sheet. `attribution`: "Timetables: <credits> | © OpenStreetMap contributors".

**Along the way:** only near the walks (riders can't stop), walking buffer, walks of 100 m or more; positions and times along the whole route; at most `APP_ALONG_THE_WAY_MAX_PLACES`.

**Pro:** like street routes (entitlement `routes`, 403 `PREMIUM_REQUIRED`).

**Failures:** no connection (nothing runs and too far to walk) → A→B 422 `TRANSIT_NO_CONNECTION`; on a day route that leg is a straight walk estimate (5 km/h) and `degraded: true`. Transit service timeout (`TRANSIT_TIMEOUT_MS`), 5xx (retried once) or its daily quota (`TRANSIT_DAILY_QUOTA`, counted in Redis, warning at 80%) → 503 `ROUTING_UNAVAILABLE`.

**Caching:** each MOTIS answer (mapped, not the raw 200 KB) is cached by rounded points, the minute and arrive-by for `TRANSIT_CACHE_SECONDS` (default 600). Timetables change, so not for 7 days like street routes.

## Nearby (unchanged idea, new data)

`GET /places/nearby` ranks Tripinly places by `popularity / (1 + km)^1.2`, cursor-paginated; if the first page ends with fewer than 10, it is filled up to `limit` with OSM attractions, museums, historic sites and landmarks by distance. Location not stored or logged (query strings are stripped from request logs).

## Around a pin — `GET /places/around` (Tripinly Pro, 2026-11-17)

The app's "Around" button on a stop opens a ring the user drags to a radius; the app asks `GET /places/around?lat=&lng=&radiusMeters=&categories=&limit=` (radius 50–5000 m, default 500; at most `APP_AROUND_MAX_PINS`, default 150, also the default `limit`). The listed places in the circle (OSM, or a Tripinly spot on a public trip: `source = 'osm' OR popularity > 0`), ranked hot first (from `APP_PLACE_RANK_MIN_HOT_COUNT`, most hot first), Tripinly spots before OSM places, then nearest. When the circle holds more than fit (Shahin, 2026-11-18), they are spread over it rather than the nearest only: the ring is cut into cells a quarter of the radius wide, and each cell's best place (hot, then Tripinly spot, then best known, then nearest) comes before any cell's second, so growing the ring always shows new places out to its edge. `categoryCounts` counts every kind in the circle whatever `categories` asks, so every chip keeps its number. Pro through the same `routes` entitlement (one Pro key for now); 403 `PREMIUM_REQUIRED` otherwise. The point is used for the query only, never stored or logged.

## Popular spots

`GET /places/popular?bbox=&excludeTripId=` lists Tripinly places in the bbox by popularity (bbox side ≤ 5°, no zoom), leaving out places already used in `excludeTripId`, which the caller must be able to view.
