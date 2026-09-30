# Tripinly — Architecture and Infrastructure

## Processes

| Process | Runs | Railway service |
|---|---|---|
| **api** | NestJS HTTP server + Socket.IO gateway | `api` (public domain, HTTPS terminated by Railway) |
| **worker** | Same codebase, `main.worker.ts`: BullMQ processors (thumbnails, OSM import, counter rebuild, notification planning and push batching, email, account deletion and data export) and realtime events raised there | `worker` (no public domain) |
| **postgres** | PostgreSQL 16 with PostGIS | Railway Postgres with PostGIS (use a PostGIS-enabled image/template; run `CREATE EXTENSION IF NOT EXISTS postgis` in the first migration) |
| **redis** | Queues, Socket.IO adapter, rate limits, short caches | Railway Redis |

External: Cloudflare R2 (photos, exports), Firebase (FCM), Resend (email), Google and Apple identity endpoints, **openrouteservice** (routing, API key), **Photon** (search; public komoot instance at first with fair use, self-hosted Railway service later), **Geofabrik** extracts (OSM import).

Premium testing before the RevenueCat webhook exists: `npm run entitlement:grant -- <username> best_route_realtime [days]` (0 days revokes).

Nightly counter rebuild: BullMQ queue `social`, job `recount` at 03:40 UTC in the worker (like and comment counters, place popularity).

Account work: BullMQ queue `account` in the worker, one job at a time. `delete` (one per user, job id `delete-{userId}`, resumable, 10 attempts), `export` (3 attempts, then the export is marked `failed`), `sweep` hourly at :17 (retries failed deletions, re-queues lost ones, expires 7-day-old exports, gives up on exports pending over 6 hours) and `purge-consent-proofs` daily at 04:10 UTC. Export ZIPs are built in the OS temp dir and uploaded in one PUT (up to 5 GB).

OSM import tooling: `osmium` (osmium-tool, installed in the Docker image) filters and exports `.osm.pbf` extracts; a streaming transform loads batches into a temp staging table, then upserts into `places`. BullMQ queue `osm-import` in the worker (one job at a time, monthly schedule per region, retries after 10/20/40 minutes). `npm run osm:import [-- region…] [--file extract.osm.pbf]` runs an import directly, e.g. for the first load of an environment.

## Repository layout

```
src/
  main.ts                 # api entry
  main.worker.ts          # worker entry
  app.module.ts
  common/                 # guards, filters, interceptors, pagination, i18n, errors, config
  modules/
    auth/ users/ consents/ trips/ markers/ photos/ social/
    places/ discovery/ invites/ notifications/ moderation/
    account/ billing/ realtime/
  jobs/                   # queue names, job payload types
prisma/
  schema.prisma
  migrations/
i18n/
  en/ hu/ de/ ...         # errors.json, push.json, email.json
test/
  integration/            # Testcontainers-based e2e per module
  factories/              # test data builders
docs/knowledge/           # this folder
```

## Key libraries

`@nestjs/*`, `@nestjs/swagger`, `@nestjs/config` (validated with zod or Joi), `@nestjs/throttler` (Redis store), `@nestjs/event-emitter`, `@nestjs/bullmq` + `bullmq`, `@nestjs/websockets` + `@nestjs/platform-socket.io` + `socket.io` (pinned to the version `@nestjs/platform-socket.io` ships, so there is one copy) + `@socket.io/redis-adapter` + `@socket.io/redis-emitter` (worker → sockets), `socket.io-client` (tests only), `prisma` + `@prisma/client`, `nestjs-i18n`, `class-validator`, `class-transformer`, `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`, `sharp` (thumbnails, EXIF stripping; its prebuilt libvips cannot decode HEIC, so the app uploads JPEG), `firebase-admin`, `resend`, `google-auth-library` (Google ID token), `jose` (Apple token verification, JWT signing), `fflate` (streaming ZIP for data exports; small and dependency-free), `pino` via `nestjs-pino`.

Adding anything else: state the reason.

## Environment variables

| Name | Purpose |
|---|---|
| `NODE_ENV`, `PORT`, `LOG_LEVEL` | `LOG_LEVEL` is a pino level (`info` default) |
| `DATABASE_URL` | Postgres |
| `REDIS_URL` | Redis |
| `JWT_ACCESS_SECRET` (≥ 32 chars, HS256), `JWT_ACCESS_TTL_SECONDS` (900), `JWT_REFRESH_TTL_DAYS` (60) | Tokens |
| `GOOGLE_CLIENT_IDS` | Comma-separated accepted audiences (iOS + Android + web client IDs). Unset = Google sign-in answers 503 |
| `APPLE_BUNDLE_ID`, `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY` | Apple sign-in verification and token revocation. All four or none; unset = Apple sign-in answers 503. The `.p8` key may use literal `\n` |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | Private photo bucket (R2 API token with Object Read & Write on that bucket). Key, secret and bucket together or not at all; unset = photo endpoints answer 503. No public bucket URL: clients get signed URLs |
| `R2_ENDPOINT` | Overrides `https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com`, e.g. the local VersityGW S3 stand-in (`http://localhost:7070`). Signed URLs use this host, so clients must reach it |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | FCM: the service account key JSON from the Firebase console (Project settings → Service accounts), raw or base64. Worker only. Unset = no pushes (in-app notifications still work); malformed = refused at boot |
| `RESEND_API_KEY`, `EMAIL_FROM` | Email through Resend. Worker only. `EMAIL_FROM` (e.g. `Tripinly <no-reply@mail.tripinly.app>`, on a domain verified in Resend) is required with the key. Unset = emails skipped with a warning |
| `APP_LINK_BASE_URL` | Base of share and invite links (`<base>/invites/<token>`). Defaults to the `tripinly://app` scheme until there is an App Links / Universal Links domain |
| `ENCRYPTION_KEY` | 32 random bytes, base64 (`openssl rand -base64 32`). AES-256-GCM for stored Apple refresh tokens, and the HMAC key for consent-proof subject hashes. API and worker. Never rotate it without re-encrypting |
| `DEV_AUTH_ENABLED` | `true` enables `POST /v1/auth/dev` for local work without Google/Apple accounts. Refused at boot in production |
| `ORS_API_KEY`, `ORS_BASE_URL` | openrouteservice. Without a key, routes are straight lines (`degraded`) |
| `ORS_DIRECTIONS_DAILY_QUOTA`, `ORS_MATRIX_DAILY_QUOTA` | Calls per UTC day before falling back to straight lines (default 2000 / 500, the free plan) |
| `PHOTON_BASE_URL` | Photon geocoder (public or self-hosted). Default `https://photon.komoot.io` |
| `OSM_IMPORT_REGIONS` | Geofabrik extract paths. Default `europe/austria,europe/hungary` |
| `OSM_IMPORT_ENABLED` | `true` on the worker to schedule imports and queue the initial load of never-imported regions. Default `false` (an import downloads hundreds of MB) |
| `OSM_IMPORT_CRON` | Monthly refresh schedule, UTC. Default `0 3 2 * *` |
| `GEOFABRIK_BASE_URL` | Default `https://download.geofabrik.de` |
| `OSM_IMPORT_TMP_DIR` | Scratch space for downloads (a few GB per region). Default: the OS temp dir |
| `REVENUECAT_API_KEY`, `REVENUECAT_WEBHOOK_AUTH` | RevenueCat secret API key (subscriber lookup; account deletion deletes the customer, worker) and the webhook's shared Authorization value (with the webhook). Unset key = customer deletion skipped with a warning |
| `CONSENT_PROOF_RETENTION_YEARS` | How long the minimal consent proof is kept after account deletion (default 5) |

All validated at startup (`src/common/config/env.ts`); the app refuses to boot if one is missing. Each variable is added to the schema by the stage that first uses it, so local development never needs keys for features that don't exist yet.

## Environments

- **local:** docker-compose with `postgis/postgis:16-*` and Redis; VersityGW as the S3 stand-in (MinIO no longer publishes images); FCM and email mocked.
- **staging** and **production:** separate Railway environments with separate databases, buckets and Firebase projects.

## Operational basics

- Structured JSON logs with request ID; never log tokens, emails, birth dates, locations or photo URLs with signatures.
- `/health` and `/health/ready` for Railway health checks.
- Migrations run as a release step (`prisma migrate deploy`) before the new api/worker version starts.
- Graceful shutdown: stop accepting HTTP, drain Socket.IO, let BullMQ finish active jobs.
- Photo URLs: the bucket is private. Every photo URL returned by the API is a signed GET URL (default 1 hour) with an unguessable object key, so a trip switching to private, a deleted photo, or a block takes effect without leaving working public links behind.
