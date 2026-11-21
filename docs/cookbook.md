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
