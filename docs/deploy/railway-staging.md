# Railway staging: step by step

This sets up the **staging** environment: Postgres with PostGIS, Redis, and two services built from this repository (`api` and `worker`). Production is the same later, with its own values, once Shahin says so.

Values marked 🔑 are secrets. Paste them only into Railway (or Cloudflare / Firebase), never into chat, issues or commits.

## 0. Before you start

You need:

- the Railway account, connected to GitHub with access to `shahin68/tripinly-backend`;
- a terminal with `openssl` (macOS and Linux have it) to generate three secrets;
- for photos: a Cloudflare account (step 3);
- optional: the openrouteservice key, the RevenueCat secret key, the Firebase service account JSON.

## 1. Project and databases

1. Railway → **New Project** → **Empty project**. Name it `tripinly`. Railway creates the `production` environment; add another with the environment switcher at the top → **New environment** → `staging`, and work in `staging` from here on.
2. **+ Create** → **Template** → search **PostGIS** → deploy it. (Railway's plain Postgres has no PostGIS; our first migration needs it.) Rename the service to `postgres`.
3. **+ Create** → **Database** → **Redis**. Rename it to `redis`.

## 2. Secrets you generate yourself

Run each once and keep the output only until it's pasted into Railway:

```sh
openssl rand -base64 48   # JWT_ACCESS_SECRET
openssl rand -base64 32   # ENCRYPTION_KEY  (never change it later: it decrypts stored Apple tokens)
openssl rand -hex 32      # DEV_AUTH_SECRET (staging only)
```

## 3. Photo storage (Cloudflare R2)

1. Cloudflare dashboard → **R2 Object Storage** → enable R2 (the free tier covers staging; it asks for a card).
2. **Create bucket** → name `tripinly-staging`, location automatic. Leave public access **off**.
3. R2 → **Manage API tokens** → **Create API token** → permission **Object Read & Write**, limited to the bucket `tripinly-staging`. Create it and keep the page open: it shows the **Access Key ID** 🔑 and **Secret Access Key** 🔑 once.
4. Note your **Account ID** (R2 overview page, right side).

## 4. Shared variables (used by both services)

Project → **Settings** → **Shared Variables** → environment `staging` → add:

| Variable                  | Value              |
| ------------------------- | ------------------ |
| `NODE_ENV`                | `production`       |
| `DEPLOY_ENV`              | `staging`          |
| `LOG_LEVEL`               | `info`             |
| `JWT_ACCESS_SECRET` 🔑    | from step 2        |
| `ENCRYPTION_KEY` 🔑       | from step 2        |
| `R2_ACCOUNT_ID`           | from step 3        |
| `R2_ACCESS_KEY_ID` 🔑     | from step 3        |
| `R2_SECRET_ACCESS_KEY` 🔑 | from step 3        |
| `R2_BUCKET`               | `tripinly-staging` |

## 5. The `api` service

1. **+ Create** → **GitHub Repo** → `shahin68/tripinly-backend`. Rename the service to `api`.
2. Service → **Settings**:
   - **Source → Branch:** `develop` (staging follows develop).
   - **Build:** Dockerfile (Railway picks up the `Dockerfile` at the repository root).
   - **Deploy → Custom Start Command:** `node dist/main.js`.
   - **Deploy → Pre-deploy Command:** `npx prisma migrate deploy`. Migrations run before every deploy; without it the database stays empty.
   - **Deploy → Healthcheck Path:** `/v1/health/ready`, timeout `120` seconds.
   - **Deploy → Restart Policy:** On Failure, 5 retries.
   - Railway's config files (Config as Code) are closed to new services, so these settings are entered by hand.
   - **Networking → Generate Domain.** That's the staging API address until there's a real domain.
3. Service → **Variables**:
   - **Add all shared variables** (button at the top of the variables list).
   - `DATABASE_URL` → **Add Reference** → `postgres` → `DATABASE_URL`.
   - `REDIS_URL` → **Add Reference** → `redis` → `REDIS_URL`.
   - `DEV_AUTH_ENABLED` = `true` and `DEV_AUTH_SECRET` 🔑 = from step 2 (test sign-in while Google and Apple aren't set up; refused on production).
   - `DEV_ACCOUNTS_PRO` = `true` (dev sign-in accounts get every Pro feature, e.g. routes, until the paywall exists; needs `DEV_AUTH_ENABLED`; refused on production). The smoke test's route step needs it.
   - `ORS_API_KEY` 🔑 = your openrouteservice key (optional; without it routes are straight lines). Leave `ORS_BASE_URL` unset: it defaults to `https://api.heigit.org/openrouteservice`, and keys from the openrouteservice dashboard work there.
4. **Deploy.** The first deploy runs all migrations.

## 6. The `worker` service

1. **+ Create** → **GitHub Repo** → the same repository. Rename it to `worker`.
2. **Settings:** branch `develop`; **Custom Start Command:** `node dist/main.worker.js` (without it the service runs the image's default command, which is the api); **Restart Policy:** On Failure, 5 retries; **Resource limits:** memory at least 4 GB (the OSM import's osmium step needs it; 1 GB gets it killed). No pre-deploy command, no healthcheck, no domain.
3. **Variables:**
   - all shared variables, plus `DATABASE_URL` and `REDIS_URL` references as for `api`;
   - `OSM_IMPORT_ENABLED` = `true` (loads Austria and Hungary places on first start, then monthly; the first import takes a while and downloads a few hundred MB);
   - `PLACE_IMAGES_SYNC_ENABLED` = `true` (copies Wikimedia Commons images of places into storage, daily; needs the R2 variables);
   - `REVENUECAT_API_KEY` 🔑 = your RevenueCat secret key (optional; account deletion deletes the RevenueCat customer with it);
   - `FIREBASE_SERVICE_ACCOUNT_JSON` 🔑 = the whole service account JSON (optional; without it no pushes).
4. **Deploy.**

Email (`RESEND_API_KEY`, `EMAIL_FROM`) waits for the domain; until then emails are skipped with a warning.

## 7. Legal documents (once)

Onboarding needs published Terms and Privacy documents. Staging uses placeholders until the real ones exist:

```sh
npm i -g @railway/cli && railway login
railway link            # pick tripinly → staging → api
railway ssh -- npm run db:seed
```

`railway ssh` needs an SSH key: if it says none was found, run `ssh-keygen -t ed25519`, accept the defaults, run the command again and let it register the key. If the seed reports that `legal_documents` does not exist, the migrations haven't run: run `railway ssh -- npx prisma migrate deploy` first and check the api's pre-deploy command.

## 8. Smoke test

From a checkout of this repository (`npm ci` once):

```sh
DEV_AUTH_SECRET=<the staging value> node scripts/smoke-test.mjs https://<api domain>
```

On Windows `cmd`, set the secret on its own line first (no quotes, no trailing space): `set DEV_AUTH_SECRET=<value>`, then `node scripts/smoke-test.mjs https://<api domain>`. In PowerShell: `$env:DEV_AUTH_SECRET="<value>"`.

If dev sign-in answers 404, `DEV_AUTH_ENABLED=true` is missing on the api or the secret doesn't match. If photos time out, check that the worker runs `node dist/main.worker.js` (its logs must not show `Mapped {/v1/...} route` lines).

It checks health, test sign-in, onboarding, a trip and marker with a live event, a photo upload processed by the worker, a route, and deletes its test account at the end. Every line should show ✓.

## 9. Test accounts for the apps

```sh
DEV_AUTH_SECRET=<the staging value> node scripts/seed-test-accounts.mjs https://<api domain>
```

(On Windows, set the secret first as in step 8.) It signs in two developer accounts, `tester` and `tester2`, finishes their onboarding, deletes the trips they own and creates the same three again: **Vienna weekend** (public, 2 days, 5 stops), **Budapest with a friend** (private, `tester2` is an editor) and **Empty trip**. In a debug build of the app, use the developer sign-in with subject `tester` or `tester2`. Run it again whenever you want the known starting data back.

## Checklist of every value

| Where                    | Variable                                                                                                                                    | Status                                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Shared                   | `NODE_ENV`, `DEPLOY_ENV`, `LOG_LEVEL`, `R2_BUCKET`                                                                                          | plain values                                                                                                                      |
| Shared                   | `JWT_ACCESS_SECRET`, `ENCRYPTION_KEY`                                                                                                       | generated (step 2)                                                                                                                |
| Shared                   | `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`                                                                                 | Cloudflare (step 3)                                                                                                               |
| api + worker             | `DATABASE_URL`, `REDIS_URL`                                                                                                                 | Railway references                                                                                                                |
| api                      | `DEV_AUTH_ENABLED`, `DEV_AUTH_SECRET`, `DEV_ACCOUNTS_PRO`                                                                                   | staging only                                                                                                                      |
| api                      | `ORS_API_KEY`                                                                                                                               | you hold it                                                                                                                       |
| api + worker             | `REVENUECAT_API_KEY`                                                                                                                        | you hold it (api: the purchase webhook reads purchases with it; worker: account deletion)                                         |
| api                      | `REVENUECAT_WEBHOOK_AUTH`                                                                                                                   | a long random value; the same value goes in RevenueCat's webhook Authorization header (a `Bearer ` prefix on either side is fine) |
| worker                   | `FIREBASE_SERVICE_ACCOUNT_JSON`                                                                                                             | from Firebase, when ready                                                                                                         |
| worker                   | `OSM_IMPORT_ENABLED`                                                                                                                        | `true`                                                                                                                            |
| worker                   | `PLACE_IMAGES_SYNC_ENABLED`                                                                                                                 | `true` (copies Commons images of places; the first run takes hours at one request a second)                                       |
| later                    | `RESEND_API_KEY`, `EMAIL_FROM`, `GOOGLE_CLIENT_IDS`, `APPLE_*`, `APP_LINK_BASE_URL`                                                         | need the domain, developer accounts or the webhook                                                                                |
| api                      | `TRANSIT_ENABLED`, `TRANSIT_REGIONS` (+ `TRANSIT_BASE_URL`, `TRANSIT_TIMEOUT_MS`, `TRANSIT_CACHE_SECONDS`, `TRANSIT_DAILY_QUOTA`, optional) | public transport routes: set up the two transit services first, `docs/deploy/transit.md`                                          |
| transit, transit-builder | `R2_*`, `TRANSIT_REGIONS`, `RAILWAY_API_TOKEN`, `TRANSIT_SERVICE_ID`                                                                        | see `docs/deploy/transit.md`                                                                                                      |
| api                      | the `APP_*` tuning values below                                                                                                             | optional: the default applies while unset                                                                                         |

### App tuning values (api)

Each one is optional and has a default. A value outside its range stops the api from booting, so check the range before changing one. The ones the apps read are sent by `GET /v1/app-config` and apply after the api restarts and the app relaunches.

| Variable                        | Default | Range     | What it changes                                                                       |
| ------------------------------- | ------- | --------- | ------------------------------------------------------------------------------------- |
| `APP_PLACES_REFRESH_SECONDS`    | 300     | ≥ 10      | How old a map square's places get before the app reloads them                         |
| `APP_PHOTO_MAX_EDGE_PX`         | 2560    | 1024–4096 | Longest photo edge the app uploads                                                    |
| `APP_PHOTO_JPEG_QUALITY`        | 85      | 50–100    | JPEG quality of uploaded photos                                                       |
| `APP_PHOTO_PARALLEL_UPLOADS`    | 2       | 1–4       | Photos uploaded at once                                                               |
| `APP_PIN_LARGE_MIN_PROMINENCE`  | 95      | 0–100     | Prominence from which a place pin is largest                                          |
| `APP_PIN_MEDIUM_MIN_PROMINENCE` | 60      | 0–100     | Prominence from which a place pin is middle-sized                                     |
| `APP_MAP_MAX_PINS`              | 150     | 20–1000   | Most place pins on the map at once                                                    |
| `APP_AROUND_MAX_PINS`           | 150     | 10–500    | Most places Around a pin sends at once, spread over the ring                          |
| `APP_ALONG_THE_WAY_MAX_PLACES`  | 40      | 10–200    | Most places along the way a route returns, spread over ten stretches of it            |
| `APP_PHOTO_PIN_MIN_PROMINENCE`  | 90      | 0–100     | Prominence from which a pin shows its place's photo…                                  |
| `APP_PHOTO_PIN_MIN_HOT_COUNT`   | 3       | ≥ 1       | …or the hot count from which it does                                                  |
| `APP_MAP_MAX_PHOTO_PINS`        | 100     | 0–500     | Most photo pins at once                                                               |
| `APP_PIN_DOT_BELOW_ZOOM`        | 14      | 0–22      | Below this camera zoom, place pins are small dots                                     |
| `APP_TRIP_MAX_MEMBERS`          | 50      | ≥ 2       | Most people in one trip, owner included                                               |
| `APP_PLACE_PHOTO_PIN_MIN_LIKES` | 3       | ≥ 1       | Likes from people other than the uploader before a stop photo can represent its place |
| `APP_PLACE_RANK_MIN_HOT_COUNT`  | 1       | ≥ 1       | Hot count from which a place is a hot spot and ranks by it instead of prominence      |
| `APP_PLACE_PHOTO_DAILY_LIMIT`   | 20      | ≥ 1       | Place photos one person may add a day                                                 |
| `APP_EXPLORE_NEARBY_RADIUS_KM`  | 50      | 1–500     | Radius of Explore's nearby trips                                                      |

A PR that adds, renames or removes a variable adds its row here in the same change.

### OSM import (worker)

The worker loads OpenStreetMap places (cafés, restaurants, sights, museums, parks and the rest of the imported kinds, with their addresses) into our `places` table, region by region, from Geofabrik extracts. These variables go on the **worker** only (the api never imports). Every one is read when the worker starts, so a change applies at the next restart; Railway restarts the worker when a variable is saved.

| Variable             | Default                                             | Accepted values                                                           | What it does                                                                                                                                                                                                                                                                                            |
| -------------------- | --------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OSM_IMPORT_ENABLED` | `false`                                             | `true` / `false`                                                          | The main switch. `true`: the worker schedules the monthly import of every region and, on start, queues the first load of any region never imported. `false`: no imports run on their own, and the worker removes the schedules it made before. The places already imported stay.                        |
| `OSM_IMPORT_CRON`    | `0 3 2 * *` (03:00 UTC on the 2nd of every month)   | a cron expression in UTC (minute hour day-of-month month day-of-week)     | When the scheduled import runs. Each region runs once at that time, one after another. Examples: `0 3 * * 0` every Sunday 03:00 UTC, `0 2 1 */3 *` every three months. Geofabrik updates its extracts daily, so more often than weekly brings little. Ignored while `OSM_IMPORT_ENABLED` is not `true`. |
| `OSM_IMPORT_REGIONS` | `europe/austria,europe/hungary`                     | comma-separated Geofabrik paths (lowercase, e.g. `europe/germany/bayern`) | Which regions are imported. Adding one: its first load is queued on the next start. Removing one: it is no longer refreshed or scheduled; its places stay as they are.                                                                                                                                  |
| `OSM_IMPORT_TMP_DIR` | the system temp folder                              | a folder path on the worker                                               | Where the extract is downloaded and processed. It needs a few GB per region while an import runs; files are deleted afterwards.                                                                                                                                                                         |
| `GEOFABRIK_BASE_URL` | `https://download.geofabrik.de`                     | an http(s) URL                                                            | Where extracts are downloaded from. Change only for a mirror.                                                                                                                                                                                                                                           |
| `QRANK_URL`          | `https://qrank.toolforge.org/download/qrank.csv.gz` | an http(s) URL                                                            | The QRank list (Wikidata items ranked by Wikipedia views, CC0) every import reads to rank places by how well known they are. Change only for a mirror.                                                                                                                                                  |

**How an import behaves:** one import runs at a time (a database lock stops a second one, also one started by hand). A failed scheduled import is retried up to three more times, 10, 20 and 40 minutes later. A rerun with nothing changed in OpenStreetMap rewrites nothing. Places that disappeared from OpenStreetMap are hidden (`isActive = false`), never deleted, so stops on them keep working. The worker needs at least 4 GB of memory for it (see the worker setup above).

**Running an import now:** open a shell in the worker with the Railway CLI (`railway login`, `railway link` to pick the project and environment, then `railway ssh --service worker`; the dashboard's right-click on the worker → Copy SSH Command gives the same command) and run `npm run osm:import -- europe/austria` for one region, or `npm run osm:import` for every region in `OSM_IMPORT_REGIONS`. This runs whatever `OSM_IMPORT_ENABLED` and `OSM_IMPORT_CRON` say, and prints a summary line per region when it ends. The schedule is unchanged by it.

**Without the CLI:** set `OSM_IMPORT_CRON` to a time a few minutes ahead in UTC (for example `30 20 17 11 *` for 20:30 UTC on 17 November); the worker restarts and runs every region at that time. Put it back to `0 3 2 * *` afterwards, or it runs again on that day next year.

**Typical uses:** turn imports off for a while with `OSM_IMPORT_ENABLED=false`; move the monthly run with `OSM_IMPORT_CRON`; refresh right away (for example to fill in addresses) with the command above.

### Showing more Commons photos on map pins

A place pin shows a photo only when all of these hold:

1. **The place has an image.** Either a photo of ours that may represent it, or a Wikimedia Commons image copied by the worker. Commons images exist only for places whose OSM data links one (Wikidata main image, `wikimedia_commons` or `image` tag) with a free licence. `PLACE_IMAGES_SYNC_ENABLED=true` must be set on the worker; the first sync takes hours, later ones run daily. Places without such a link never get a Commons image, whatever the settings.
2. **The place is well known or hot enough:** prominence at least `APP_PHOTO_PIN_MIN_PROMINENCE`, or hot count at least `APP_PHOTO_PIN_MIN_HOT_COUNT`.
3. **It's among the best ranked pins in view:** at most `APP_MAP_MAX_PHOTO_PINS` photo pins at once, out of at most `APP_MAP_MAX_PINS` pins.
4. **The map is zoomed in** to at least `APP_PIN_DOT_BELOW_ZOOM`; below it every pin is a dot.

So, on the api, from biggest effect to smallest:

| To show more photos               | Change                                                                        | Example                                                    |
| --------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Less famous places too            | Lower `APP_PHOTO_PIN_MIN_PROMINENCE`                                          | 90 → 60 (the medium pin size); 0 shows every place's image |
| Places marked hot by fewer people | Lower `APP_PHOTO_PIN_MIN_HOT_COUNT`                                           | 3 → 1                                                      |
| More photo pins in a busy view    | Raise `APP_MAP_MAX_PHOTO_PINS` (and `APP_MAP_MAX_PINS` if it's the lower one) | 100 → 200                                                  |
| Photos when zoomed further out    | Lower `APP_PIN_DOT_BELOW_ZOOM`                                                | 14 → 13                                                    |

More photo pins mean more image downloads and more markers drawn: raise them a step at a time and check the map stays smooth on an older phone. Changes apply after the api restarts (Railway restarts it when a variable is saved) and the app relaunches.

## 10. Runbook: OSM import, place photos and brand logos

How to switch things on and off, run them, and see what they're doing. Written after the first brand import (Shahin, 2026-11-20).

### Switches

| What | Variable | Service | Default | Values |
| --- | --- | --- | --- | --- |
| OSM import at all (scheduled and first loads) | `OSM_IMPORT_ENABLED` | worker | `false` | `true` / `false` |
| When the scheduled import runs | `OSM_IMPORT_CRON` | worker | `0 3 2 * *` (03:00 UTC on the 2nd) | cron in **UTC** |
| Which regions | `OSM_IMPORT_REGIONS` | worker | `europe/austria,europe/hungary` | comma-separated Geofabrik paths |
| Place photos and brand logos copied from Wikimedia | `PLACE_IMAGES_SYNC_ENABLED` | worker | `false` | `true` / `false` (needs the R2 variables) |
| Brands at all: logos, the brand picker, "Brand store" on new spots | `BRAND_LOGOS_ENABLED` | api | `false` | `true` / `false` |
| Which brands show their logo | `BRAND_LOGOS_SHOWN` | api | empty (no logos) | comma-separated names or Wikidata ids, any case, e.g. `Zara,H&M,Q147662` |

Saving a variable restarts that service. A change to the brand switches shows on the map once the in-view cache expires (a few minutes). Names in `BRAND_LOGOS_SHOWN` must match the brand's name as OpenStreetMap spells it (`H&M`, `McDonald's`); a Wikidata id always matches.

**Logos off quickly:** set `BRAND_LOGOS_ENABLED=false` on the api. **One brand off:** take it out of `BRAND_LOGOS_SHOWN`.

### Running an OSM import by hand (Windows `cmd`)

One-time setup:
1. `npm install -g @railway/cli --allow-scripts=@railway/cli` (without `--allow-scripts` npm blocks the step that downloads `railway.exe`), then `railway --version`.
2. `railway login` (opens the browser).
3. `railway ssh` needs an SSH key: `ssh-keygen`, Enter at every prompt.

Each time:
1. `cd %USERPROFILE%` (any folder; nothing from the repo is needed).
2. `railway link`: pick the project, the `staging` environment and the `worker` service.
3. `railway ssh`: a Linux shell inside the worker, in `/app`. **The import command only works here, not on your PC.**
4. `npm run osm:import -- europe/austria` for one region, or `npm run osm:import` for every region in `OSM_IMPORT_REGIONS`.
5. Wait for `OSM import of europe/austria succeeded: seen …, inserted …, updated …, deactivated …` (a few minutes). Keep the window open; closing it stops the import. `exit` leaves the worker.

The Railway dashboard's right-click on the worker → **Copy SSH Command** gives steps 2 and 3 in one.

### A scheduled import at a set time

Set `OSM_IMPORT_CRON` on the worker to `<minute> <hour UTC> <day> <month> *`; Budapest/Vienna is UTC+1 in winter, UTC+2 in summer. Example: 13:14 Budapest on 20 November (winter) = `14 12 20 11 *`. Afterwards set it back to `0 3 2 * *`, or it runs again on that day next year. A failed scheduled import retries three times, 10, 20 and 40 minutes later, and **every retry downloads the whole extract again** (Austria is ~780 MB): don't chain test runs, or Geofabrik starts refusing us (see below). A manual run is usually simpler.

### Where to see logs

Railway → the service (`worker` or `api`) → **Deployments** → the active deployment → **View logs** (Deploy Logs). The search box filters lines, e.g. `OSM import`, `Brand logos`, `Place images`. `railway logs` (after `railway link`) shows the same in the terminal.

Lines and what they mean:
- `OSM import of <region>: downloading` / `… MB to download` / `filtering with osmium` / `… places staged, saving` / `… succeeded: seen …`: an import's steps.
- `OSM import of <region>: Geofabrik publishes no checksum for it, importing unchecked`: fine; osmium still rejects a broken file.
- `Brand logos: N brands, M logos`: one logo run finished (up to 200 brands; written every run, also with 0).
- `Place images: N places, … ready, … rejected, … removed`: one place-photo run finished.
- `Wikimedia asked to slow down (HTTP 429); waiting N s`: normal, Wikimedia is busy; the worker waits as long as asked and tries again (3 tries). The worker sends no `maxlag` (it only reads), so Wikidata's lag no longer stops it.
- `Place images job sync failed: <reason>, will retry`: a run failed (Wikimedia refusing, a timeout); it's tried again 10, 20 and 40 minutes later. `Brand logos failed: <reason>`: the logos failed but the photos went on; the logos are tried again 10 minutes later.

### When logos and place photos come

The worker's image job runs on every worker start and daily at 04:30 UTC (photos rechecked weekly on Sunday 05:00 UTC). Each run does brand logos first (up to 200 brands, the brands with most places first), then place photos, at one Wikimedia request a second, and queues the next run while work is left. After an import that adds many places, the first runs take a while. **A brand needs a logo to show a square pin:** brands are created by the OSM import; logos only come with this job, so restart the worker after an import to fetch them at once.

**Why some stores of a brand show the logo and others don't (KFC in Austria vs Hungary, 2026-11-20):** a logo belongs to the brand, not to a country, so once a brand has its logo every place linked to that brand shows it. A place is linked to its brand only during an OSM import, from the OSM `brand` / `brand:wikidata` tags, which we keep since backend#89. Places imported before that (for example Hungary's restaurants) have no brand link yet and keep their category icon until their region is imported again: run `npm run osm:import -- europe/hungary` in the worker shell, or wait for the scheduled import. When the brand already has a logo, those places switch to the logo pin right after the import; a brand that is new to us gets its logo on the next image job run (or restart the worker).

### Checking progress in the database

Connect DBeaver to Postgres (the `postgres` service's TCP proxy; host, port and the `POSTGRES_*` values from its variables). Then:

```sql
-- Brands and their logos: run twice a few minutes apart; "checked" rises while the worker works.
select count(*) as brands, count("logoCheckedAt") as checked, count("logoHash") as with_logo from brands;

-- One brand
select name, "wikidataId", "logoHash" is not null as has_logo, "logoSource", "logoCheckedAt"
from brands where name ilike 'zara%';

-- Shops tied to a brand
select count(*) from places where "brandId" is not null and "isActive";

-- Recent OSM imports
select region, status, "startedAt", "finishedAt", seen, inserted, updated, deactivated, error
from osm_import_runs order by "startedAt" desc limit 10;
```

### A brand without a Wikimedia logo

Many trademark logos on Wikimedia aren't public domain, so the worker skips them. An admin can upload one instead (it always wins and is never replaced): `PUT /v1/admin/brands/{id}/logo` with the image; `DELETE /v1/admin/brands/{id}/logo` removes it. Brands are added with `POST /v1/admin/brands`, and a wrongly tied store is untied with `PUT /v1/admin/places/{id}/brand`. See Swagger (`/v1/docs` on staging).

### Troubleshooting

| You see | Means | Do |
| --- | --- | --- |
| `checksum of <region> failed with HTTP 404` | Geofabrik published no `.md5` (old code). Since backend#90 the import goes on without it. | Make sure the worker runs develop. |
| `fetch failed: redirect count exceeded` | Geofabrik is turning us away, most likely after many full downloads in a row. | Stop retries (`OSM_IMPORT_CRON` back to `0 3 2 * *`), wait a few hours, run once by hand. |
| `npm error … Could not read package.json` | The command ran on your PC. | `railway ssh` first. |
| `could not find the CLI binary … railway.exe` | npm blocked the CLI's install script. | Reinstall with `--allow-scripts=@railway/cli`. |
| Brand stores found but round pins | No logo yet, or the brand isn't in `BRAND_LOGOS_SHOWN`, or logos are off. | Check the SQL above; restart the worker; check the api variables. |
| Nothing at all after `Worker started` | Before backend#92 a failed image run left no log line. Now a failure logs `Place images job … failed: …`. | Send that line to the developer. |
| No "Brand store" row on a new spot | Logos are off, no brands imported yet, or the spot's name matches no brand. | Type a brand name, e.g. "Zara". |
