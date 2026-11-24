# Tripinly cookbook

How to run Tripinly day to day: every switch, what it changes and how to check it. This is the start of the project
cookbook planned for the release stage (Shahin, 2026-11-20); it grows with every change and is built out fully from
the runbooks (`docs/deploy/railway-staging.md`) before release. A copy lives in the project files
(`guides/cookbook.md`).

## Switches the apps read

The apps read these from `GET /v1/app-config` once when they start. Change the variable on Railway; the api
restarts by itself, and each phone follows the next time the app starts.

### Hide OpenStreetMap pins: `OSM_PINS_ENABLED`

|           |                                    |
| --------- | ---------------------------------- |
| Service   | api                                |
| Default   | `true` (OpenStreetMap places show) |
| Values    | `true` / `false`                   |
| App field | `osmPinsEnabled`                   |

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

## Jobs

### New public transport timetables: `transit-builder`

|           |                                                                                    |
| --------- | ---------------------------------------------------------------------------------- |
| Service   | transit-builder (Railway cron)                                                     |
| Schedule  | `17 4 * * *`: daily 04:17 UTC (05:17 Vienna in winter, 06:17 in summer)            |
| Where     | transit-builder → Settings → Deploy → Cron schedule (set on Railway, not in code) |
| Runs      | `node dist/scripts/transit-build.js`; restart policy never                         |
| Variables | `TRANSIT_REGIONS`, R2 keys, `TRANSIT_SERVICE_ID`, `RAILWAY_API_TOKEN`              |
| Setup     | `docs/deploy/transit.md`                                                           |

**What a run does:** downloads each city's timetables (Vienna: Wiener Linien GTFS; skipped when the server says
nothing changed). It builds only when a timetable changed, the cities in `TRANSIT_REGIONS` changed or the streets
are 30 days old: it downloads Austria from Geofabrik, builds the MOTIS data, uploads the package to R2 and redeploys
`transit`, which then serves it. Nothing changed: it stops after the check, in seconds.

**Run it now:** transit-builder → **Run now** (e.g. after a failed night or a new city). `--force` builds even when
nothing changed: set the start command to `node dist/scripts/transit-build.js --force` for one run, then set it back.

**Log lines:**

| Line                                                    | Means                                                                                    |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `Timetables unchanged; nothing to build`                | Normal night; the live package stays                                                     |
| `Building vienna: timetables changed` (or `cities changed`, `streets due`, `forced`) | A build started                                                   |
| `<url>: <reason>; trying again in 1 min`                | A download failed (network or 5xx); it tries three times, 1 and 5 minutes apart          |
| `MOTIS import took N s`                                 | The data is built                                                                        |
| `Uploaded transit/packages/<time>.tar.gz`               | The new package is in R2                                                                 |
| `Transit service redeploy started`                      | `transit` restarts with it (healthy again once MOTIS loaded it)                          |
| `RAILWAY_API_TOKEN or TRANSIT_SERVICE_ID not set: …`    | Built and uploaded, but redeploy `transit` by hand                                       |
| `failed: Download of <url> failed: <reason>`            | All three tries failed; Railway shows **Crashed**. Nothing was saved, the live service keeps the old package and the next night tries again |

**Check it:** the newest file in R2 under `transit/packages/` and `transit/current.json` (`builtAt`, `feeds`); in
the app, the tram button routes Leopold Museum → Café Sacher. Going back to the package before: see
"Rollback" in `docs/deploy/transit.md`.
