# Public transport routes on Railway (transit + transit-builder)

Two extra services in the same Railway project and environment, built from `docker/transit.Dockerfile`. Neither needs a volume, a database or GitHub Actions. Background: `docs/knowledge/10-maps-places-routing.md`, "Public transport".

| Service | What it does | RAM (Vienna) | Runs |
|---|---|---|---|
| `transit` | Downloads the newest MOTIS package from R2 and answers routes on the private network | ~300 MB | always |
| `transit-builder` | Checks the timetables daily; when one changed, builds a new package, uploads it and redeploys `transit` | ~1.5 GB for about a minute | cron, daily |

## 1. transit-builder (first, so a package exists)

1. **New service → GitHub repo** `tripinly-backend`, name it `transit-builder`.
2. **Settings → Build:** Dockerfile path `docker/transit.Dockerfile`.
3. **Settings → Deploy:** custom start command `node dist/scripts/transit-build.js`; **Cron schedule** `17 4 * * *` (daily; any hour works, the live service is never touched while building). Restart policy: never.
4. **Variables:**

| Variable | Value |
|---|---|
| `TRANSIT_REGIONS` | `vienna` (shared variable, also used by the api) |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | references to the shared R2 variables |
| `TRANSIT_SERVICE_ID` | `${{transit.RAILWAY_SERVICE_ID}}` (add after step 2 creates `transit`) |
| `RAILWAY_API_TOKEN` | a **project token** for this environment (Project settings → Tokens). Secret; without it the builder still builds and logs "redeploy the transit service by hand" |

5. Run it once by hand (**Deploy** / "Run now"). The log ends with `Uploaded transit/packages/…` (about 2 minutes: the Austria extract download is most of it).

## 2. transit

1. **New service → GitHub repo** `tripinly-backend`, name it exactly `transit` (the api finds it at `transit.railway.internal`).
2. **Settings → Build:** Dockerfile path `docker/transit.Dockerfile` (start command is the image's default, `node dist/scripts/transit-serve.js`).
3. **Settings → Deploy:** healthcheck path `/api/v1/health` (503 until MOTIS is ready, so a redeploy switches over without downtime). No public domain.
4. **Variables:** `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` (references) and `PORT=8080`.

## 3. api

| Variable | Default | Range | Set |
|---|---|---|---|
| `TRANSIT_ENABLED` | `false` | true/false | `true` once `transit` is healthy; off, the tram button is dimmed everywhere |
| `TRANSIT_REGIONS` | `vienna` | city ids with a recipe | shared variable |
| `TRANSIT_BASE_URL` | `http://transit.railway.internal:8080` | http(s) URL | leave unset |
| `TRANSIT_TIMEOUT_MS` | 8000 | 1000–30000 | leave unset |
| `TRANSIT_CACHE_SECONDS` | 600 | 60–3600 | leave unset |
| `TRANSIT_DAILY_QUOTA` | 20000 | 100–1000000 | leave unset |

Smoke test after the api redeploys: `GET /v1/app-config` lists `transitAreas: [{ id: "vienna", … }]`, and in the app the tram button routes Leopold Museum → Café Sacher by U2.

## Adding a city

1. A PR adds its recipe to `src/modules/routing/transit/transit-regions.ts` (feeds, licence, credit, covered box, Geofabrik extract), merged.
2. Add the id to `TRANSIT_REGIONS` on **transit-builder only** (e.g. `vienna,paris`) and run it: it sees the cities changed, builds both and redeploys `transit`.
3. Then the same value on the **api** (or the shared variable): the apps get the new area at their next start, no app update.

Taking a city out works the same way in reverse (api first).

## Rollback

R2 keeps the live package and the one before (`transit/packages/`). To go back, edit `transit/current.json` in the R2 bucket so `package` names the older file, then redeploy `transit`.
