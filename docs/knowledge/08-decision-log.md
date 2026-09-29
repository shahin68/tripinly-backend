# Tripinly — Decision Log

Append-only. Newest at the bottom. Format: date · decision · why · who decided.

| Date | Decision | Why | By |
|---|---|---|---|
| 2026-09-24 | Backend stack: NestJS + PostgreSQL/PostGIS + Prisma + Redis + Socket.IO, hosted on Railway | Small project, strong TypeScript ecosystem, geo queries | Product owner + agent |
| 2026-09-24 | REST + JSON, `/v1`, OpenAPI for KMP client generation | Client team generates API layer | Product owner |
| 2026-09-24 | Sign-in only with Google and Apple; JWT access + rotating refresh tokens | Product requirement | Product owner |
| 2026-09-24 | Minimum age 16 | Safe single EU threshold | Product owner |
| 2026-09-24 | Map data from Google Maps / OSM on the client; no external attraction feeds; Nearby and Popular spots use only Tripinly data ranked by likes | Product requirement, cost | Product owner |
| 2026-09-24 | "Add to my trips" creates an independent, editable copy owned by the copier; no photos/comments copied; "Copied from @handle" while source exists | Copies must survive the author's account deletion | Product owner |
| 2026-09-24 | Account deletion deletes everything the user created, including owned trips shared with collaborators; copies made by others survive | Product requirement | Product owner |
| 2026-09-24 | Multiple photos per marker, one user-chosen cover shown in the pin; gallery is scrollable | Product requirement (design prototype shows only one) | Product owner |
| 2026-09-24 | People find each other by username handle search and invite links; no follow system in v1 | Keep v1 small | Product owner |
| 2026-09-24 | Best route: straight-line ordering free; real travel times paid | Routing APIs cost money | Product owner |
| 2026-09-24 | Push: comments on your markers, added to trip, collaborator changes (batched), likes (grouped). Email only for export and deletion | Product requirement | Product owner |
| 2026-09-24 | Reporting and blocking with admin review in v1 | App Store / Google Play UGC requirements | Product owner |
| 2026-09-24 | Content localized; i18n for push, email and API errors | Product requirement | Product owner |
| 2026-09-24 | Photos stored in a private R2 bucket, served via signed URLs; EXIF stripped | Privacy (visibility changes, GPS in photos) | Agent (engineering) |
| 2026-09-24 | Defaults set by agent, changeable: invite links valid 7 days; usernames held 30 days after deletion; 30 photos/marker, 15 MB each; comments flat, markers only; place matching within ~30 m | Needed concrete values to build | Agent — confirm with product owner |
| 2026-09-27 | Client draws the map with the Google Maps SDK (free on mobile) with Google POI icons hidden; backend never stores Google data | Product owner knows Google Maps; MapLibre Compose not stable yet; Google terms forbid storing Places data | Product owner + agent |
| 2026-09-27 | Places come from our own DB: user-created places + OpenStreetMap POIs imported monthly (default launch region Austria + Hungary) | Free, storable (ODbL with attribution), map never empty | Product owner + agent |
| 2026-09-27 | Search: our places + Photon for addresses/cities, proxied by the backend | Free, storable | Agent, accepted by product owner |
| 2026-09-27 | Routing via openrouteservice; route lines and along-the-way places free for everyone; premium best route uses ORS matrix + own ordering | Low cost; Google Routes would cost ~10× | Product owner + agent |
| 2026-09-27 | New feature: places along a route (attractions, cafés, restaurants) via PostGIS buffer query on the route line | Product requirement | Product owner |
| 2026-09-28 | Billing via RevenueCat: entitlement `tripinly_pro` → feature `best_route_realtime`; products monthly, yearly, lifetime (lifetime = no expiry); webhook feeds `entitlements`; account deletion deletes the RevenueCat customer | Resolves open question on purchases | Product owner |
| 2026-09-28 | Consent proof after deletion follows EU practice: minimal pseudonymous record kept for `CONSENT_PROOF_RETENTION_YEARS` (default 5, Hungarian limitation period), configurable for legal counsel | Product owner asked for "EU standards, whatever long it is"; GDPR sets no fixed period | Product owner + agent |
| 2026-09-28 | One agent builds backend and client; work goes on feature branches merged into `develop`; nothing is pushed to `master` directly | Coordination from one place | Product owner |
| 2026-09-28 | Runtime and tooling versions: Node 24 LTS, NestJS 12, TypeScript 6, Prisma 7.10 with the `pg` driver adapter (Prisma 8 is still RC), oxlint (Nest 12's default linter) | Current stable majors; Jest keeps working with ESM-only Nest 12 through Node 24's native `require(esm)` | Agent (engineering) |
| 2026-09-28 | Added `helmet` for standard security headers | Cheap hardening of every response | Agent (engineering) |
| 2026-09-28 | Added `google-auth-library` (Google ID tokens), `jose` (Apple tokens, HS256 access JWTs) and `@nestjs/throttler` with our own Redis storage (the community Redis store doesn't support Nest 12 yet). The limiter fails open if Redis is down | Planned in 06; avoids an unmaintained dependency | Agent (engineering) |
| 2026-09-28 | `POST /v1/auth/dev` sign-in for local development and tests, behind `DEV_AUTH_ENABLED`, refused in production | No Google/Apple/Firebase accounts yet; the client can be built end to end against a local backend | Agent (engineering) |
| 2026-09-28 | A sign-up that gives an under-16 birth date is deleted immediately; nothing is kept | Minimum age 16; don't hold data about minors | Agent (engineering) |
| 2026-09-28 | If Apple's authorization-code exchange fails, sign-in still succeeds and the exchange is retried at the next Apple sign-in | Apple outages shouldn't block sign-in; the token is only needed at deletion | Agent (engineering) |
| 2026-09-28 | Accounts are keyed only by provider + subject; the same email under Google and Apple gives two accounts (no automatic linking) | Apple private relay emails and unverified emails make email linking a takeover risk | Agent (engineering) |
| 2026-09-28 | A push token belongs to whoever registered it last (re-registering moves it); logout needs only the refresh token | Shared phones must not get the previous user's pushes; logout must work with an expired access token | Agent (engineering) |
| 2026-09-28 | Usernames can be changed once every 30 days; the old handle is held 30 days | Default accepted by the product owner | Product owner |
| 2026-09-29 | Confirmed defaults: owner-only invites, no viewer role, "Day n" for undated trips, limits 20 days/trip, 50 markers/day, 200 trips/user (plus 50 members/trip and 20 active invites/trip as engineering limits) | Accepted by the product owner | Product owner |
| 2026-09-29 | Points stored as `lat`/`lng` with a generated `geography` column | Prisma can read and write the row normally while PostGIS queries use an indexed point; no raw SQL on every insert | Agent (engineering) |
| 2026-09-29 | Day dates are derived (`startDate + position`) instead of stored; with a start date, `endDate` always equals `startDate + days − 1`. Shrinking a trip never deletes days that have markers | One source of truth, so dates and days can't drift apart | Agent (engineering) |
| 2026-09-29 | Added `@nestjs/event-emitter` for domain events (`trip.*`, `day.*`, `marker.*`, `member.*`, `user.blocked`) | Planned in 06; realtime and notifications subscribe later | Agent (engineering) |
| 2026-09-29 | Invite links default to the `tripinly://app` scheme (`APP_LINK_BASE_URL`) until there is a domain; expired or revoked invites answer 410 `INVITE_EXPIRED`; owners can list active invites (`GET /trips/{id}/invites`) | No domain yet; revoking needs the invite IDs | Agent (engineering) |
| 2026-09-29 | Moderated (hidden) trips are visible only to their owner and admins, not to editors | The trip-access rule "hidden content is visible only to its author" | Agent (engineering) |
| 2026-09-29 | Limit and similar domain refusals use one code, `LIMIT_REACHED`, with `details.resource` and `details.max` | Fewer codes for the client to handle | Agent (engineering) |
| 2026-09-29 | Places not from OSM are listed (in-view, search, nearby, popular) only once liked on a public trip (`popularity > 0`); otherwise visible only to people who can see a marker at them, also when picked by `placeId` | A custom pin like "our flat" on a private trip must never surface for others | Agent (engineering) |
| 2026-09-29 | In-view returns `places` and `clusters` as two arrays; a bbox too large for the zoom answers `BBOX_TOO_LARGE` (not `VALIDATION_FAILED`) | Plain types for the generated Kotlin client; the code was already in the error list | Agent (engineering) |
| 2026-09-29 | Search matches every OSM `name:<lang>` (new `places.searchText`), so "Museum of Art History" finds the Kunsthistorisches Museum | Tourists search in their own language | Agent (engineering) |
| 2026-09-29 | Added `bullmq` and `@nestjs/bullmq` (job queues, first used by the monthly OSM import) and `osmium-tool` in the Docker image | Planned in 06 and the osm-import skill | Agent (engineering) |
| 2026-09-29 | OSM import: rows unchanged since the last run are not rewritten (a rerun changes nothing); a user place carrying the same OSM ids is left alone; places are tracked per Geofabrik region (`osmRegion`) for deactivation; deactivation is skipped (run `degraded`) when an extract has more than 20% fewer places than the last good run. Scheduling is off unless `OSM_IMPORT_ENABLED=true` | osm-import skill rules made concrete | Agent (engineering) |
