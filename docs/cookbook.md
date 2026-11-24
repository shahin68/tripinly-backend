# Tripinly cookbook

How to run Tripinly day to day: what runs where and how the parts are connected, every variable and switch, the
scheduled jobs, what is live in the apps and what needs an app update, payments, maps, pushes, costs, and what to do
when something breaks. It is written for operating Tripinly, not for building it: the knowledge files
(`docs/knowledge/`) explain the rules, this explains the knobs.

Every change that adds a variable, a job, a provider or a cost updates this file in the same PR. The copy in the
project files (`guides/cookbook.md`) is kept the same. Last full pass: 2026-11-24.

**Contents:** 1 How Tripinly runs · 2 Where each account lives · 3 How a change reaches people · 4 What is live in the
apps · 5 Every variable · 6 Switches · 7 Scheduled jobs · 8 Maps, places and routes · 9 Payments (Tripinly Pro) ·
10 Push, email and live updates · 11 Costs · 12 Everyday tasks · 13 Troubleshooting · 14 The apps · 15 Before
production

---

## 1. How Tripinly runs

```
  Android / iOS app ──HTTPS + WebSocket──▶ api ──┬──▶ postgres (PostGIS)      our data, places included
   │  draws the map with Google Maps SDK         ├──▶ redis                   queues, live rooms, caches
   │  buys Pro through RevenueCat SDK            ├──▶ transit (MOTIS)         public transport routes
   │                                             ├──▶ Photon                  address and city search
   │                                             ├──▶ openrouteservice        street routes, best order
   │                                             └──▶ Cloudflare R2           photos (signed links)
   │                                                     ▲
   │                    worker (same code) ──────────────┤  photo processing, pushes, email, deletion,
   │                      │                              │  exports, OSM import, Wikimedia images
   │                      ├──▶ Firebase (FCM) ──▶ pushes to the phones
   │                      ├──▶ Resend ──▶ email
   │                      └──▶ Geofabrik, QRank, Wikimedia (imports)
   │
   └──▶ RevenueCat ──webhook──▶ api (Pro on/off)       transit-builder (daily cron) ──▶ R2 ──▶ redeploys transit
```

| Railway service   | What it is                                                                                      | Built from                               | Always on                     |
| ----------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------- | ----------------------------- |
| `api`             | The REST API and the live connection (Socket.IO). The only service with a public address        | `Dockerfile`, `node dist/main.js`        | yes                           |
| `worker`          | The same code started as `node dist/main.worker.js`: every background job (list in section 7)   | `Dockerfile`, `node dist/main.worker.js` | yes                           |
| `postgres`        | PostgreSQL 16 with PostGIS (Railway's PostGIS template), on a volume                            | template                                 | yes                           |
| `redis`           | Job queues (BullMQ), the live rooms shared by api and worker, short caches, rate limits         | Railway Redis                            | yes                           |
| `transit`         | MOTIS: answers public transport routes on the private network (`transit.railway.internal:8080`) | `docker/transit.Dockerfile`              | yes                           |
| `transit-builder` | Daily cron: new timetables → new MOTIS package in R2 → redeploys `transit`                      | `docker/transit.Dockerfile`              | no, runs about a minute a day |

The api and worker talk only through Postgres and Redis: the api puts a job on a queue, the worker does it and tells
the phones through Redis. **If the worker is down,** the app still works, but photos stay "processing", no pushes or
emails go out, and account deletions and exports wait until it is back (nothing is lost; the jobs wait in Redis).

---

## 2. Where each account lives

| What                    | Where                                                    | Holds                                                                                     |
| ----------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Code                    | GitHub `shahin68/tripinly-backend`, `shahin68/tripingly` | `develop` is what staging runs; `master` is for releases. CI (GitHub Actions) on every PR |
| Hosting                 | Railway project `tripinly`, environment `staging`        | the six services above, their variables and logs                                          |
| Photo storage           | Cloudflare R2, bucket `tripinly-staging`                 | user photos, place images, brand logos, data exports, transit packages                    |
| Push                    | Firebase project `tripingly-45cb053e`                    | FCM; the service account JSON (worker), the app config values (`local.properties`)        |
| Purchases               | RevenueCat project "Tripinly"                            | products `monthly`, `yearly`, `lifetime`, entitlement `tripinly_pro`, the webhook         |
| Maps and Google sign-in | Google Cloud Console                                     | Maps SDK keys (Android, iOS), OAuth clients (web, Android, iOS)                           |
| Street routes           | HeiGIT openrouteservice dashboard                        | `ORS_API_KEY`                                                                             |
| Email                   | Resend (not set up yet: needs our domain)                | `RESEND_API_KEY`, the sending domain                                                      |
| Not yet                 | domain, Apple Developer Program, Google Play Console     | see section 15                                                                            |

Staging API: `https://api-staging-4ade.up.railway.app` (Swagger at `/v1/docs`, shown everywhere except production).
Secrets are pasted only into Railway, Cloudflare, Firebase or RevenueCat, never into chat, issues or commits.

---

## 3. How a change reaches people

| Change                                                                               | How it goes out                                                                                                                                             | App update?                                                                 |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Backend code (a merge into `develop`)                                                | Railway redeploys `api` and `worker` by itself; `api` runs the database migrations first (pre-deploy command)                                               | no                                                                          |
| A Railway variable                                                                   | Save it; Railway redeploys that service (press **Deploy** if it shows the change as staged). A bad value stops the boot with the variable's name in the log | no                                                                          |
| A value the apps read from `GET /v1/app-config` (section 5, column "App")            | The api serves it at once; each phone picks it up **the next time the app starts** (or its language changes)                                                | no                                                                          |
| Map places, search, ranking, routes, pushes and their texts, emails, Explore, rules  | Server side: effective with the deploy (map squares within a minute, the in-view cache is 60 s)                                                             | no                                                                          |
| New city for public transport                                                        | `TRANSIT_REGIONS` (section 6); the apps learn the area at their next start                                                                                  | no                                                                          |
| Place kinds, their labels, Explore periods, report reasons                           | Served by `GET /v1/app-config` in the phone's language                                                                                                      | no (a new **icon** needs one: an unknown icon id shows the plain Spot icon) |
| Anything the app draws or says itself: screens, buttons, app texts, icons, map style | A new app build through the stores                                                                                                                          | **yes**                                                                     |
| A new kind of push tap target (deep link) or push channel                            | The app must know it; older apps open the trip or just the app                                                                                              | **yes**                                                                     |
| Maps, Firebase or RevenueCat app keys, the API address                               | Built into the app (`local.properties`, section 14)                                                                                                         | **yes**                                                                     |

**Contract rule:** the backend never removes or renames a field the apps read without a new version, so older app
versions keep working after a server deploy.

---

## 4. What is live in the apps

| How fresh                                                          | What                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Live** (over the socket, as it happens)                          | An open trip: stops, days, members, trip details, trip deletion, photos ready/failed/deleted, covers, comments, like and flame counts. My Trips list changes, follows, my notifications and their dots, my Pro status, my own profile changes, my own place photos finishing |
| **Near live**                                                      | Pushes go out at once (the same one again from the same person within `NOTIFICATION_REPEAT_COOLDOWN_SECONDS` is dropped). Map places in view reload after `APP_PLACES_REFRESH_SECONDS` (300 s)                                                                               |
| **Not live** (loaded when a screen opens, pull to refresh, scroll) | Explore, Nearby, profiles and friends lists, search, place details and place pins, likes on place photos and Wikimedia images, trip likes on Explore cards                                                                                                                   |
| **Daily or slower**                                                | Wikimedia place images and brand logos (daily 04:30 UTC), public transport timetables (daily 04:17 UTC), OpenStreetMap places (monthly), counters rebuilt nightly (03:40 UTC)                                                                                                |
| **Once per app start**                                             | Everything from `GET /v1/app-config`                                                                                                                                                                                                                                         |

After a lost connection the app reconnects and reloads what it shows, so a missed live event costs nothing.

---

## 5. Every variable

Each one is checked when the service starts: a missing or out-of-range value stops the boot and the log names the
variable (never its value). Empty counts as unset. 🔑 = secret. "App" = also sent to the apps by `GET /v1/app-config`
(they use it from their next start).

### Shared (api and worker; Project → Settings → Shared Variables)

| Variable                                                                       | Default             | Values                           | What it does                                                                                                   |
| ------------------------------------------------------------------------------ | ------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                                                                     | `development`       | `production` on Railway          | Node's mode                                                                                                    |
| `DEPLOY_ENV`                                                                   | `local`             | `local`, `staging`, `production` | Which environment this is. `production` refuses dev sign-in and hides Swagger                                  |
| `LOG_LEVEL`                                                                    | `info`              | `fatal` … `trace`, `silent`      | How much is logged                                                                                             |
| `DATABASE_URL`, `REDIS_URL`                                                    | (required)          | Railway references               | The database and Redis                                                                                         |
| `JWT_ACCESS_SECRET` 🔑                                                         | (required)          | ≥ 32 characters                  | Signs access tokens. Changing it signs everyone's open sessions out of their current token (the app refreshes) |
| `JWT_ACCESS_TTL_SECONDS`                                                       | 900                 | ≥ 60                             | Access token life                                                                                              |
| `JWT_REFRESH_TTL_DAYS`                                                         | 60                  | ≥ 1                              | How long a phone stays signed in without opening the app                                                       |
| `ENCRYPTION_KEY` 🔑                                                            | (required)          | 32 bytes, base64                 | Encrypts stored Apple tokens. **Never change casually**: stored Apple tokens can't be read after               |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID` 🔑, `R2_SECRET_ACCESS_KEY` 🔑, `R2_BUCKET` | unset               | all together or none             | Photo storage. Unset: photo endpoints answer 503, the worker doesn't process or sync images                    |
| `R2_ENDPOINT`                                                                  | from the account id | URL                              | Only for a local S3 stand-in                                                                                   |
| `CONSENT_PROOF_RETENTION_YEARS`                                                | 5                   | ≥ 1                              | How long the minimal consent proof is kept after an account is deleted                                         |

### api only

**Sign-in and accounts**

| Variable                                                                   | Default          | Values                                         | What it does                                                                               |
| -------------------------------------------------------------------------- | ---------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `GOOGLE_CLIENT_IDS`                                                        | unset            | comma-separated client ids (web, Android, iOS) | Google sign-in; unset answers 503                                                          |
| `APPLE_BUNDLE_ID`, `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY` 🔑 | unset            | all four or none                               | Sign in with Apple (needs the Apple Developer account); unset answers 503                  |
| `APP_LINK_BASE_URL`                                                        | `tripinly://app` | URL                                            | Start of invite and share links; becomes `https://<domain>` once we have one               |
| `DEV_AUTH_ENABLED`                                                         | `false`          | `true` / `false`                               | Developer sign-in (`tester`, `tester2`). Refused in production                             |
| `DEV_AUTH_SECRET` 🔑                                                       | unset            | ≥ 32 characters on staging                     | The header developer sign-in needs on staging                                              |
| `DEV_ACCOUNTS_PRO`                                                         | `false`          | `true` / `false`                               | Developer accounts get Pro. **Temporary**, needs `DEV_AUTH_ENABLED`, refused in production |
| `PORT`                                                                     | 3000             | 1–65535                                        | Set by Railway                                                                             |

**Payments, routes, search**

| Variable                     | Default                                   | Values                 | What it does                                                                                                                   |
| ---------------------------- | ----------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `REVENUECAT_API_KEY` 🔑      | unset                                     | `sk_…` (v1)            | The webhook and "sync my purchase" read a customer's purchases with it (also on the **worker**: deletion removes the customer) |
| `REVENUECAT_WEBHOOK_AUTH` 🔑 | unset                                     | long random            | The webhook's password, the same value as in RevenueCat. Unset: every webhook call is refused, Pro never turns on by itself    |
| `ORS_API_KEY` 🔑             | unset                                     | HeiGIT key             | Street routes and best order. Unset: routes are straight lines                                                                 |
| `ORS_BASE_URL`               | `https://api.heigit.org/openrouteservice` | URL                    | Leave unset                                                                                                                    |
| `ORS_DIRECTIONS_DAILY_QUOTA` | 2000                                      | ≥ 1                    | Street routes per UTC day before falling back to straight lines (the free plan's limit)                                        |
| `ORS_MATRIX_DAILY_QUOTA`     | 500                                       | ≥ 1                    | Best-order calculations per UTC day before falling back to straight-line distance                                              |
| `PHOTON_BASE_URL`            | `https://photon.komoot.io`                | URL                    | Address and city search. Public instance now; our own before launch                                                            |
| `TRANSIT_ENABLED`            | `false`                                   | `true` / `false`       | Public transport routes. Off: the tram button is dimmed everywhere                                                             |
| `TRANSIT_REGIONS`            | `vienna`                                  | city ids with a recipe | Cities with public transport. Same value on `transit-builder` (section 6)                                                      |
| `TRANSIT_BASE_URL`           | `http://transit.railway.internal:8080`    | URL                    | Leave unset                                                                                                                    |
| `TRANSIT_TIMEOUT_MS`         | 8000                                      | 1000–30000             | How long one transit answer may take                                                                                           |
| `TRANSIT_CACHE_SECONDS`      | 600                                       | 60–3600                | How long the same transit answer is reused                                                                                     |
| `TRANSIT_DAILY_QUOTA`        | 20000                                     | 100–1,000,000          | Transit calls per UTC day; past it 503 (guards RAM, not a bill)                                                                |

**What the map shows**

| Variable              | Default | Values                                     | What it does                                                             |
| --------------------- | ------- | ------------------------------------------ | ------------------------------------------------------------------------ |
| `OSM_PINS_ENABLED`    | `true`  | `true` / `false`                           | OpenStreetMap places at all (section 6). App: `osmPinsEnabled`           |
| `BRAND_LOGOS_ENABLED` | `false` | `true` / `false`                           | Brand logos on square pins, the brand picker, "Brand store" on new spots |
| `BRAND_LOGOS_SHOWN`   | empty   | names or Wikidata ids, e.g. `Zara,Q178516` | The only brands whose logo shows                                         |

**Tuning numbers (`APP_…`)**

All optional. A value outside its range stops the boot, so check the range first.

| Variable                        | Default | Range     | App | What it changes                                               |
| ------------------------------- | ------- | --------- | --- | ------------------------------------------------------------- |
| `APP_PLACES_REFRESH_SECONDS`    | 300     | ≥ 10      | ✓   | How old a map square's places get before the app reloads them |
| `APP_PHOTO_MAX_EDGE_PX`         | 2560    | 1024–4096 | ✓   | Longest photo edge the app uploads (bigger = more R2 storage) |
| `APP_PHOTO_JPEG_QUALITY`        | 85      | 50–100    | ✓   | JPEG quality of uploads                                       |
| `APP_PHOTO_PARALLEL_UPLOADS`    | 2       | 1–4       | ✓   | Photos uploaded at once                                       |
| `APP_PIN_LARGE_MIN_PROMINENCE`  | 95      | 0–100     | ✓   | Prominence from which a pin is largest                        |
| `APP_PIN_MEDIUM_MIN_PROMINENCE` | 60      | 0–100     | ✓   | Prominence from which a pin is middle-sized                   |
| `APP_MAP_MAX_PINS`              | 150     | 20–1000   | ✓   | Most place pins on the map at once                            |
| `APP_PHOTO_PIN_MIN_PROMINENCE`  | 90      | 0–100     | ✓   | Prominence from which a pin shows its place's photo…          |
| `APP_PHOTO_PIN_MIN_HOT_COUNT`   | 3       | ≥ 1       | ✓   | …or the hot count from which it does                          |
| `APP_MAP_MAX_PHOTO_PINS`        | 100     | 0–500     | ✓   | Most photo pins at once (more = more image downloads)         |
| `APP_PIN_DOT_BELOW_ZOOM`        | 14      | 0–22      | ✓   | Below this zoom, place pins are dots                          |
| `APP_AROUND_MAX_PINS`           | 150     | 10–500    |     | Most places Around a pin sends, spread over the ring          |
| `APP_ALONG_THE_WAY_MAX_PLACES`  | 40      | 10–200    |     | Most places along a route, spread over ten stretches          |
| `APP_TRIP_MAX_MEMBERS`          | 50      | ≥ 2       |     | Most people in one trip, owner included                       |
| `APP_PLACE_PHOTO_PIN_MIN_LIKES` | 3       | ≥ 1       |     | Likes from others before a stop photo can represent its place |
| `APP_PLACE_RANK_MIN_HOT_COUNT`  | 1       | ≥ 1       |     | Hot count from which a place ranks by flames instead of fame  |
| `APP_PLACE_PHOTO_DAILY_LIMIT`   | 20      | ≥ 1       |     | Place photos one person may add a day                         |
| `APP_EXPLORE_NEARBY_RADIUS_KM`  | 50      | 1–500     |     | Radius of Explore's "near me"                                 |

"Showing more photos on pins" (which of these to turn, biggest effect first) is in `docs/deploy/railway-staging.md`.

### worker only

| Variable                               | Default                         | Values                                | What it does                                                                                     |
| -------------------------------------- | ------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `FIREBASE_SERVICE_ACCOUNT_JSON` 🔑     | unset                           | the JSON, raw or base64               | Pushes. Unset: no pushes; the notification center and live updates still work                    |
| `RESEND_API_KEY` 🔑, `EMAIL_FROM`      | unset                           | key + an address on a verified domain | Email (export ready, account deleted). Unset: skipped with a warning                             |
| `REVENUECAT_API_KEY` 🔑                | unset                           | the same key as on the api            | Account deletion deletes the RevenueCat customer                                                 |
| `NOTIFICATION_REPEAT_COOLDOWN_SECONDS` | 5                               | 0–300                                 | The same notification again from the same person within this time is dropped (0 = off)           |
| `APP_NOTIFICATION_MILESTONES`          | `5,25,100,500,1000,5000`        | ascending counts, up to 20            | The like and flame counts that push, once each; other likes show only in the notification center |
| `OSM_IMPORT_ENABLED`                   | `false`                         | `true` / `false`                      | OpenStreetMap imports (section 7)                                                                |
| `OSM_IMPORT_CRON`                      | `0 3 2 * *`                     | cron, UTC                             | When the monthly import runs                                                                     |
| `OSM_IMPORT_REGIONS`                   | `europe/austria,europe/hungary` | Geofabrik paths                       | Which regions are imported                                                                       |
| `OSM_IMPORT_TMP_DIR`                   | system temp                     | folder                                | Scratch space (a few GB per import)                                                              |
| `GEOFABRIK_BASE_URL`, `QRANK_URL`      | Geofabrik, QRank                | URL                                   | Only for a mirror                                                                                |
| `PLACE_IMAGES_SYNC_ENABLED`            | `false`                         | `true` / `false`                      | Copies Wikimedia images of places and brand logos into R2 (needs R2)                             |

### transit and transit-builder

| Variable               | Service | Default        | What it does                                                                  |
| ---------------------- | ------- | -------------- | ----------------------------------------------------------------------------- |
| `R2_*`                 | both    | (required)     | Where packages are stored                                                     |
| `TRANSIT_REGIONS`      | builder | `vienna`       | Which cities are built                                                        |
| `RAILWAY_API_TOKEN` 🔑 | builder | unset          | A Railway project token; without it, redeploy `transit` by hand after a build |
| `TRANSIT_SERVICE_ID`   | builder | unset          | `${{transit.RAILWAY_SERVICE_ID}}`                                             |
| `GEOFABRIK_BASE_URL`   | builder | Geofabrik      | Where the streets come from                                                   |
| `TRANSIT_WORK_DIR`     | both    | `/tmp/transit` | Scratch space (builder about 2 GB, service about 300 MB per city)             |
| `PORT`                 | transit | 8080           | Keep 8080: the api calls that port                                            |

Setup for the two services is in `docs/deploy/transit.md`.

---

## 6. Switches

### Hide OpenStreetMap pins: `OSM_PINS_ENABLED` (api, default `true`)

**`false`:** the apps show no OpenStreetMap places anywhere, only our users' own spots:

- the map's pins (and the dots of places when zoomed out)
- the map search's results, addresses and streets from Photon included
- the places along a route, and Around a pin
- Nearby: only users' spots and popular user spots

**What stays:** routes (day route, A to B, public transport, Best order), the trip's stops (also those first added
from an OpenStreetMap place: they are the trip's own), the city search when creating a trip. The
"© OpenStreetMap contributors" credit shows only where a route shows, since routes are built on OpenStreetMap roads.

**Good to know:**

- The server leaves OpenStreetMap places out of its answers (map squares, search, along the way, Around, Nearby,
  Popular), so pin limits and chip counts stay right, and app versions from before this switch follow it too (they
  only keep showing the OpenStreetMap credit).
- A user's spot made on an OpenStreetMap place (picked from search before the switch) is an OpenStreetMap place
  in our database, so it is left out too; it stays a stop on its trip.
- The map's cached squares carry the switch, so flipping it shows at once, no cache to clear.

**Check it:** `curl https://<api host>/v1/app-config` shows `"osmPinsEnabled": false`; in the app, pan the map
and search for a well-known sight: only users' spots come back. In SQL, what is still listed:
`SELECT count(*) FROM places WHERE "isActive" AND source = 'user' AND popularity > 0;`

### Public transport: `TRANSIT_ENABLED`, `TRANSIT_REGIONS`

- **On/off:** `TRANSIT_ENABLED` on the api. Off, the tram button is dimmed with a note; nothing else changes.
- **A new city:** a PR adds its recipe (`src/modules/routing/transit/transit-regions.ts`: timetable feeds, licence,
  credit, covered box, Geofabrik extract) and merges. Then add the id to `TRANSIT_REGIONS` on **transit-builder**
  first and press Run now (it builds every city and redeploys `transit`), then the same on the **api**. The apps get
  the new area at their next start. Taking a city out: api first, then builder.

### Brand logos: `BRAND_LOGOS_ENABLED`, `BRAND_LOGOS_SHOWN` (api)

Off by default; on in production only after the legal review (logos are trademarks). One brand off: take it out of
`BRAND_LOGOS_SHOWN`. All off quickly: `BRAND_LOGOS_ENABLED=false`. Shows on the map within a minute. More in
`docs/deploy/railway-staging.md` section 10.

### Imports and images: `OSM_IMPORT_ENABLED`, `PLACE_IMAGES_SYNC_ENABLED` (worker)

Off: nothing new is imported or copied; what is already there stays. See section 7.

### Developer accounts: `DEV_AUTH_ENABLED`, `DEV_AUTH_SECRET`, `DEV_ACCOUNTS_PRO` (api, staging only)

Let the testers sign in without Google or Apple, and give them Pro. Refused by the api in production; switch all three
off in the production environment.

---

## 7. Scheduled jobs

All times UTC (Vienna/Budapest is UTC+1 in winter, UTC+2 in summer). The worker's schedules live in Redis and are
written again on every worker start; the transit builder's is a Railway cron.

| Job                              | Runs                                                                                       | Where                               | What it does                                                                                          |
| -------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------- | ----------------------------------------------------------------------------------------------------- |
| OSM import                       | `OSM_IMPORT_CRON` (default 03:00 on the 2nd, monthly); first load of a new region on start | worker, `OSM_IMPORT_ENABLED`        | Loads each region's places from Geofabrik into `places`; failed runs retry after 10, 20, 40 min       |
| Wikimedia images and brand logos | daily 04:30, recheck Sundays 05:00, and on every worker start                              | worker, `PLACE_IMAGES_SYNC_ENABLED` | Copies place images and brand logos into R2 at one request a second                                   |
| Counters rebuild                 | daily 03:40                                                                                | worker                              | Recounts likes, flames, comments, so a missed update can't drift for long                             |
| Account sweep                    | hourly at :17                                                                              | worker                              | Keeps stuck deletions moving, deletes expired data exports (7 days) and gives up on exports stuck 6 h |
| Consent proof purge              | daily 04:10                                                                                | worker                              | Deletes consent proofs older than `CONSENT_PROOF_RETENTION_YEARS`                                     |
| Photo cleanup                    | hourly at :17 (only with R2 set)                                                           | worker                              | Removes uploads never finished and failed photos, rows first, then files                              |
| Public transport timetables      | daily 04:17 (`17 4 * * *`)                                                                 | `transit-builder` cron              | See below                                                                                             |

### New public transport timetables: `transit-builder`

|           |                                                                                   |
| --------- | --------------------------------------------------------------------------------- |
| Service   | transit-builder (Railway cron)                                                    |
| Schedule  | `17 4 * * *`: daily 04:17 UTC (05:17 Vienna in winter, 06:17 in summer)           |
| Where     | transit-builder → Settings → Deploy → Cron schedule (set on Railway, not in code) |
| Runs      | `node dist/scripts/transit-build.js`; restart policy never                        |
| Variables | `TRANSIT_REGIONS`, R2 keys, `TRANSIT_SERVICE_ID`, `RAILWAY_API_TOKEN`             |
| Setup     | `docs/deploy/transit.md`                                                          |

**What a run does:** downloads each city's timetables (Vienna: Wiener Linien GTFS; skipped when the server says
nothing changed). It builds only when a timetable changed, the cities in `TRANSIT_REGIONS` changed or the streets
are 30 days old: it downloads Austria from Geofabrik, builds the MOTIS data, uploads the package to R2 and redeploys
`transit`, which then serves it. Nothing changed: it stops after the check, in seconds.

**Run it now:** transit-builder → **Run now** (e.g. after a failed night or a new city). `--force` builds even when
nothing changed: set the start command to `node dist/scripts/transit-build.js --force` for one run, then set it back.

**Log lines:**

| Line                                                                                 | Means                                                                                                                                       |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `Timetables unchanged; nothing to build`                                             | Normal night; the live package stays                                                                                                        |
| `Building vienna: timetables changed` (or `cities changed`, `streets due`, `forced`) | A build started                                                                                                                             |
| `<url>: <reason>; trying again in 1 min`                                             | A download failed (network or 5xx); it tries three times, 1 and 5 minutes apart                                                             |
| `MOTIS import took N s`                                                              | The data is built                                                                                                                           |
| `Uploaded transit/packages/<time>.tar.gz`                                            | The new package is in R2                                                                                                                    |
| `Transit service redeploy started`                                                   | `transit` restarts with it (healthy again once MOTIS loaded it)                                                                             |
| `RAILWAY_API_TOKEN or TRANSIT_SERVICE_ID not set: …`                                 | Built and uploaded, but redeploy `transit` by hand                                                                                          |
| `failed: Download of <url> failed: <reason>`                                         | All three tries failed; Railway shows **Crashed**. Nothing was saved, the live service keeps the old package and the next night tries again |

**Check it:** the newest file in R2 under `transit/packages/` and `transit/current.json` (`builtAt`, `feeds`); in
the app, the tram button routes Leopold Museum → Café Sacher. Going back to the package before: see
"Rollback" in `docs/deploy/transit.md`.

### OSM import and images by hand

Run an import now, set one for a time, read its logs and check progress in SQL: `docs/deploy/railway-staging.md`
section 10 (also in the project files, `guides/osm-import-and-brand-logos.md`). The short version: `railway link`
(worker), `railway ssh`, then `npm run osm:import -- europe/austria`. Every retry downloads the whole extract
(Austria about 780 MB): don't chain test runs, or Geofabrik starts refusing us.

---

## 8. Maps, places and routes

| Part                         | Comes from                                                                           | Notes                                                                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| The map itself               | Google Maps SDK in the apps (keys in `local.properties`)                             | Drawing only: Google's own places are hidden, and **nothing from Google is ever sent to or stored by our server** |
| Places (pins)                | Our `places` table: OpenStreetMap places imported monthly, plus spots our users make | Ranked by flames (hot count), then by fame (QRank: Wikipedia views). Switch: `OSM_PINS_ENABLED`                   |
| Place photos                 | Our users' photos (once liked enough), else Wikimedia Commons images copied into R2  | Wikimedia copies only for places OSM links to an image with a free licence                                        |
| Brand logos                  | Wikimedia, or uploaded by an admin                                                   | Section 6                                                                                                         |
| Search                       | Our places first, then Photon for addresses and cities                               | Photon: public komoot instance now (fair use, no guarantee); self-hosted before launch                            |
| Street routes, best order    | openrouteservice (HeiGIT), free plan                                                 | Street routes are **Pro**; best order is free. Past the daily quota: straight lines, never an error               |
| Public transport             | Our MOTIS service, timetables from each city's open data                             | Pro, Vienna first. Outside covered cities the tram button is dimmed                                               |
| Places along the way, Around | Our places                                                                           | Pro                                                                                                               |

**Credits we must show:** "© OpenStreetMap contributors" where our places or routes show (the apps handle it), the
timetable credit with public transport (sent by the api), Google's logo and notices on the map (never cover them).
**Rules:** never call OpenStreetMap's own servers (tiles, Nominatim, Overpass) from production; Geofabrik and QRank
downloads are fine.

**Location** from Nearby and the map is used for the one query and never stored or logged.

---

## 9. Payments (Tripinly Pro)

```
app (RevenueCat SDK) ──buys──▶ App Store / Google Play ──▶ RevenueCat ──webhook──▶ api ──▶ users.pro…
     │                                                                              │
     └──"sync my purchase" (POST /me/pro/sync) right after buying ───────────────────┘──▶ pro.changed to every phone
```

- **Products:** `monthly`, `yearly`, `lifetime`, all attached to the entitlement **`tripinly_pro`** (the backend
  looks for that exact name) and to the current offering. Today they live in RevenueCat's **Test Store**; real store
  products come with the store accounts.
- **What Pro unlocks** (decided on the server, never by the app): street routes with places along the way (day and
  A → B), public transport routes, Around a pin. Best order is free.
- **The webhook:** RevenueCat → Integrations → Webhooks, URL `https://<api host>/v1/billing/revenuecat/webhook`,
  Authorization header = `REVENUECAT_WEBHOOK_AUTH`. On every purchase, renewal, cancellation, billing issue, expiry,
  refund or transfer the api re-reads the customer from RevenueCat and tells all their phones (`pro.changed`).
- **Keys:** app side the public keys `revenuecat.androidKey` / `revenuecat.iosKey` in `local.properties`; server side
  `REVENUECAT_API_KEY` (v1 secret key, api and worker) and `REVENUECAT_WEBHOOK_AUTH` (api).
- **Give someone Pro without a purchase** (testing): `npm run entitlement:grant -- <username> routes [days]` in an api
  shell (no days = forever, 0 = revoke). On staging, developer accounts already have it (`DEV_ACCOUNTS_PRO`).
- **Account deletion** deletes the RevenueCat customer too. Step-by-step setup: project files
  `guides/revenuecat-setup.md`.

If Pro doesn't turn on after a purchase: look for `RevenueCat webhook refused: …` in the api logs. Most often the
two Authorization values differ; if they look the same, delete the variable on Railway and add it again (Railway
once kept serving an old value).

---

## 10. Push, email and live updates

- **Live updates:** the api's Socket.IO connection (`/v1/realtime`). The worker publishes through Redis, so both
  reach the phones. Nothing to operate beyond Redis being up.
- **Push:** the worker sends through Firebase Cloud Messaging to Android and iOS (iOS needs the APNs key in Firebase
  and the Apple Developer account). Every notification pushes at once, except:
  - likes on trips and photos and flames on a user's spot push only at `APP_NOTIFICATION_MILESTONES`;
  - saves, unfollows, single flames and likes between milestones show only in the notification center;
  - the same notification again from the same person within `NOTIFICATION_REPEAT_COOLDOWN_SECONDS` is dropped;
  - no push about a stop's comments while those comments are open, and none about a collaborator's change while that
    trip's map is open, on any of the person's devices (the notification and its red dot still come);
  - each kind follows its switch in the app's notification settings (also an Android channel of the same name).
- **Texts** of pushes and emails are on the server (English, German, Hungarian): changing them needs no app update.
- **Email** (Resend, worker): only "your data export is ready" and "your account is deleted". Waits for our domain.
- Tokens Firebase reports as dead are removed by themselves.

---

## 11. Costs

Measured numbers replace these estimates at the release checklist (review doc with the method:
https://claude.ai/artifact/MEB4CZ7y68DDbkWENJnUuC, 2026-11-15). Railway bills by the second for what a service
**uses**, not its limit (about $10 per GB of RAM a month, $20 per vCPU a month, $0.15 per GB of volume a month).

| Service                  | Plan and limit                                                                                             | Our use (estimate)                                   | Cost a month        | Where to look                           |
| ------------------------ | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------- | --------------------------------------- |
| Railway plan             | Hobby: $5 fee includes $5 of usage                                                                         | 6 services                                           | $5 + usage above $5 | Workspace → Usage                       |
| `api`                    | 8 GB RAM per service                                                                                       | 300–500 MB                                           | ~$3–6               | api → Metrics                           |
| `worker`                 | 8 GB RAM, needs ≥ 4 GB for the OSM import                                                                  | 300–500 MB idle, 3–6 GB for ~1 h each monthly import | ~$4–8               | worker → Metrics (import day)           |
| `postgres`               | **Volume 5 GB, the Hobby maximum** (can't shrink)                                                          | likely 1–2.5 GB                                      | ~$4–7               | the volume → Metrics, SQL in the review |
| `redis`                  | small                                                                                                      | < 100 MB                                             | ~$1                 | redis → Metrics                         |
| `transit`                | runs always                                                                                                | ~300 MB per city                                     | ~$3                 | transit → Metrics                       |
| `transit-builder`        | about a minute a day                                                                                       | ~1.5 GB while building                               | cents               | transit-builder → Metrics               |
| Cloudflare R2            | Free: 10 GB, 1 M writes, 10 M reads a month; then $0.015/GB, $4.50/M writes, $0.36/M reads; downloads free | place images ~0.2 MB each, user photos 3–6 MB each   | $0 now              | R2 → bucket → Metrics                   |
| Firebase Cloud Messaging | free                                                                                                       |                                                      | $0                  | Firebase console                        |
| RevenueCat               | free until $2,500 revenue a month, then a share of revenue                                                 |                                                      | $0                  | RevenueCat → Billing                    |
| openrouteservice         | free: 2,000 routes and 500 matrices a day (our quotas match)                                               | Pro users only                                       | $0                  | HeiGIT dashboard                        |
| Photon (komoot)          | free, fair use                                                                                             | every search                                         | $0                  | —                                       |
| Resend                   | free: 3,000 a month, 100 a day                                                                             | not live                                             | $0                  | resend.com → Usage                      |
| Google Maps SDK (mobile) | map loads free, billing account required                                                                   | apps only                                            | $0                  | Google Cloud → Billing                  |
| GitHub Actions           | free while the repos are public                                                                            | every PR                                             | $0                  | GitHub → Billing                        |

**Estimated total today:** about $15–25 a month, all Railway. **Still to come:** a domain (~€10–15 a year), Apple
Developer Program ($99 a year), Google Play ($25 once).

**Limits to watch:**

- **Postgres 5 GB volume.** OpenStreetMap places are most of it. Measure before adding a region; keep it under
  about 4 GB.
- **R2 free tier (10 GB).** User photos grow fastest (each keeps its original). Then about $0.015 per GB a month.
- **Pro plan vs Hobby:** Pro is $20 including $20 of usage, so once usage passes $20 it costs exactly $15 more.
  Self-hosted Photon (tens of GB) doesn't fit Hobby's volume, so it pushes us to Pro.
- **Pushes and routes are free but capped by our own rules and quotas**, so one viral spot can't flood anyone.

**Spending guards to set:** Railway → Workspace → Usage → Usage limits (an alert and a hard limit); Cloudflare →
Notifications → Billing usage alert for R2.

---

## 12. Everyday tasks

| Task                                  | How                                                                                                                                                                                                              |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read logs                             | Railway → the service → Deployments → active deployment → **View logs**; the search box filters (`OSM import`, `Place images`, `RevenueCat`). `railway logs` after `railway link`                                |
| Is it up?                             | `GET /v1/health` (process up) and `GET /v1/health/ready` (database, Redis, migrations); Railway's health check uses the second                                                                                   |
| Open a shell                          | Railway CLI: `railway login`, `railway link` (project, environment, service), `railway ssh`. On Windows install with `npm install -g @railway/cli --allow-scripts=@railway/cli`; needs an SSH key (`ssh-keygen`) |
| Look into the database                | `postgres` → add a TCP proxy (port 5432) → DBeaver with that host and port and the `POSTGRES_*` values. Railway shows no Data tab for the PostGIS template                                                       |
| Smoke test after a big change         | `DEV_AUTH_SECRET=<staging value> node scripts/smoke-test.mjs https://<api host>`: health, sign-in, trip, live event, photo, route; every line ✓                                                                  |
| Reset the test accounts               | `node scripts/seed-test-accounts.mjs https://<api host>` (same secret): `tester` and `tester2` with three known trips. On Windows `cmd`: `set DEV_AUTH_SECRET=<value>` on its own line first                     |
| Publish the legal placeholders (once) | `railway ssh -- npm run db:seed` on the api                                                                                                                                                                      |
| Make someone an admin                 | In SQL: `UPDATE users SET role = 'admin' WHERE username = '<name>';` Admins use Swagger (`/v1/docs`) for the admin endpoints below                                                                               |
| Review reports                        | `GET /v1/admin/reports` (oldest first), then `PATCH /v1/admin/reports/{id}` with `dismiss`, `hide_content`, `delete_content` or `suspend_user`; every action is logged                                           |
| Fix a brand                           | `POST /v1/admin/brands`, `PUT`/`DELETE /v1/admin/brands/{id}/logo`, `PUT /v1/admin/places/{id}/brand`                                                                                                            |
| Rotate a secret                       | Project files `guides/railway-key-rotation-2026-10.md`, one section per secret (Postgres, Redis, JWT, encryption, R2, ORS, Firebase, RevenueCat)                                                                 |
| Roll back a deploy                    | Railway → the service → Deployments → an older one → **Redeploy**. Migrations only go forward, so roll back code only when the newer migration is harmless to the old code                                       |
| Roll back the transit package         | `docs/deploy/transit.md`, Rollback                                                                                                                                                                               |
| A user's data or deletion             | The app does both (Settings). Export: ZIP in R2 for 7 days, emailed once Resend is live. Deletion removes everything, the RevenueCat customer included                                                           |

---

## 13. Troubleshooting

| You see                                                                                | Means                                                                                     | Do                                                                                                         |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| api deploy fails its health check: `Readiness check "migrations" failed: pending …`    | The pre-deploy command didn't run the migrations                                          | api → Settings → Deploy → Pre-deploy Command `npx prisma migrate deploy`, redeploy                         |
| A service crashes at boot with `Invalid environment configuration` and a variable name | A value is missing, malformed or out of range                                             | Fix that variable (section 5)                                                                              |
| A variable shows as set but the service acts as if it isn't                            | Railway kept an old value                                                                 | Delete the variable, add it again, deploy                                                                  |
| Photos stay "processing"                                                               | The worker is down or runs the api's start command                                        | worker → Settings → start command `node dist/main.worker.js`; its log must not show `Mapped {/v1/…}` lines |
| No pushes at all                                                                       | `FIREBASE_SERVICE_ACCOUNT_JSON` unset or wrong, or the phone has push off                 | worker logs; in the app, Settings → Notifications                                                          |
| Pro doesn't turn on after buying                                                       | Webhook refused                                                                           | Section 9                                                                                                  |
| Routes are straight lines                                                              | No `ORS_API_KEY`, or today's quota is used up                                             | api logs; quotas reset at 00:00 UTC                                                                        |
| Tram button dimmed everywhere                                                          | `TRANSIT_ENABLED` off, or `transit` unhealthy                                             | api variable; transit → logs                                                                               |
| transit-builder **Crashed**                                                            | A download or the build failed; the live service is unaffected                            | Section 7 (log lines); Run now to retry                                                                    |
| No places on the map                                                                   | No import has run (`OSM_IMPORT_ENABLED` unset on the worker), or `OSM_PINS_ENABLED=false` | Set it, watch for `OSM import of … succeeded`                                                              |
| `fetch failed: redirect count exceeded` in an OSM import                               | Geofabrik is turning us away after many downloads                                         | Stop retries, wait a few hours, run once by hand                                                           |
| Brand stores show round pins                                                           | No logo yet, brand not in `BRAND_LOGOS_SHOWN`, or logos off                               | `docs/deploy/railway-staging.md` section 10                                                                |
| The worker is OOM-killed during an import                                              | Less than 4 GB memory                                                                     | worker → Settings → Resource limits                                                                        |
| Postgres stops accepting writes                                                        | The 5 GB volume is full                                                                   | Measure (section 11); remove a region's places or move to Pro                                              |
| Dev sign-in answers 404                                                                | `DEV_AUTH_ENABLED` off or the secret doesn't match                                        | api variables                                                                                              |
| An app shows an old behaviour after a variable change                                  | The app reads `app-config` only at start                                                  | Close and reopen the app                                                                                   |

---

## 14. The apps

**Build values** live in the client repo's untracked `local.properties` (never committed; a Gradle `-P` property of
the same name works in CI):

| Key                                                                                                                         | What                                                                                                       | Without it                                  |
| --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `MAPS_API_KEY`, `MAPS_API_KEY_IOS`                                                                                          | Google Maps SDK keys (restrict to the app's package and SHA-1 / bundle id before release)                  | the map stays blank                         |
| `tripinly.googleWebClientId`                                                                                                | The backend's Google web client id (not secret)                                                            | no Google sign-in                           |
| `tripinly.devAuthSecret`                                                                                                    | Staging's developer sign-in secret (debug builds)                                                          | no developer sign-in                        |
| `firebase.projectId`, `firebase.senderId`, `firebase.appId`, `firebase.apiKey`, `firebase.ios.appId`, `firebase.ios.apiKey` | Firebase app values (from `google-services.json` / `GoogleService-Info.plist`, which stay out of the repo) | no push                                     |
| `revenuecat.androidKey`, `revenuecat.iosKey`                                                                                | RevenueCat public keys (`test_…` for the Test Store now)                                                   | the paywall says purchases aren't available |

**Which server:** `-Pbuildkonfig.flavor=local|staging|production` (default staging). Production has no address
until the domain exists.

**Builds:** Android `./gradlew :androidApp:assembleDebug`; iOS from Xcode (it builds the shared framework). CI builds
both and runs every test on each PR; a PR is ready when CI is green. Release builds, signing and store uploads follow
the client's `release-checklist` skill (needs the store accounts).

**Debug vs release:** debug builds log HTTP calls in full and show developer sign-in; release builds log neither
tokens, emails, birth dates, locations nor signed photo links.

---

## 15. Before production

Production is a second Railway environment with its own database, Redis, bucket, Firebase project and keys. Before it
goes live (tracked in the release checklist):

- Set `DEPLOY_ENV=production`; leave `DEV_AUTH_ENABLED` and `DEV_ACCOUNTS_PRO` off (the api refuses them anyway).
- Domain: `APP_LINK_BASE_URL`, app links, the invite page, Resend's sending domain.
- Apple: Developer Program, Sign in with Apple (`APPLE_*`), the APNs key in Firebase.
- RevenueCat: real App Store and Play products, production public keys in the apps.
- Our own Photon (`PHOTON_BASE_URL`) and a decision on Hobby vs Pro (section 11).
- Brand logos only after the legal review; legal texts reviewed by the lawyer and published.
- Measure every cost and replace the estimates in section 11.
- Walk through every key in section 5 one by one for the production environment.
