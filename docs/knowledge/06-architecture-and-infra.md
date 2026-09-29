# Tripinly — Architecture and Infrastructure

## Processes

| Process | Runs | Railway service |
|---|---|---|
| **api** | NestJS HTTP server + Socket.IO gateway | `api` (public domain, HTTPS terminated by Railway) |
| **worker** | Same codebase, `main.worker.ts`: BullMQ processors (thumbnails, push, email, deletion, export, popularity recompute, like grouping) | `worker` (no public domain) |
| **postgres** | PostgreSQL 16 with PostGIS | Railway Postgres with PostGIS (use a PostGIS-enabled image/template; run `CREATE EXTENSION IF NOT EXISTS postgis` in the first migration) |
| **redis** | Queues, Socket.IO adapter, rate limits, short caches | Railway Redis |

External: Cloudflare R2 (photos, exports), Firebase (FCM), Resend (email), Google and Apple identity endpoints, **openrouteservice** (routing, API key), **Photon** (search; public komoot instance at first with fair use, self-hosted Railway service later), **Geofabrik** extracts (OSM import).

OSM import tooling: `osmium` (osmium-tool) in the worker image for filtering `.osm.pbf` extracts; loaded with `COPY` into a staging table, then upserted into `places`.

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

`@nestjs/*`, `@nestjs/swagger`, `@nestjs/config` (validated with zod or Joi), `@nestjs/throttler` (Redis store), `@nestjs/event-emitter`, `@nestjs/bullmq` + `bullmq`, `@nestjs/websockets` + `socket.io` + `@socket.io/redis-adapter`, `prisma` + `@prisma/client`, `nestjs-i18n`, `class-validator`, `class-transformer`, `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`, `sharp` (thumbnails, EXIF stripping, HEIC via libheif if available), `firebase-admin`, `resend`, `google-auth-library` (Google ID token), `jose` (Apple token verification, JWT signing), `pino` via `nestjs-pino`.

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
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_PUBLIC_BASE_URL` | Storage |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | FCM |
| `RESEND_API_KEY`, `EMAIL_FROM` | Email |
| `APP_LINK_BASE_URL` | Share and invite links |
| `ENCRYPTION_KEY` | 32 random bytes, base64 (`openssl rand -base64 32`). AES-256-GCM for stored Apple refresh tokens |
| `DEV_AUTH_ENABLED` | `true` enables `POST /v1/auth/dev` for local work without Google/Apple accounts. Refused at boot in production |
| `ORS_API_KEY`, `ORS_BASE_URL` | openrouteservice |
| `PHOTON_BASE_URL` | Photon geocoder (public or self-hosted) |
| `OSM_IMPORT_REGIONS` | Geofabrik extract paths, e.g. `europe/austria,europe/hungary` |
| `REVENUECAT_API_KEY`, `REVENUECAT_WEBHOOK_AUTH` | RevenueCat secret API key (subscriber lookup, customer deletion) and the webhook's shared Authorization value |
| `CONSENT_PROOF_RETENTION_YEARS` | How long the minimal consent proof is kept after account deletion (default 5) |

All validated at startup (`src/common/config/env.ts`); the app refuses to boot if one is missing. Each variable is added to the schema by the stage that first uses it, so local development never needs keys for features that don't exist yet.

## Environments

- **local:** docker-compose with `postgis/postgis:16-*` and Redis; MinIO for S3; FCM and email mocked.
- **staging** and **production:** separate Railway environments with separate databases, buckets and Firebase projects.

## Operational basics

- Structured JSON logs with request ID; never log tokens, emails, birth dates, locations or photo URLs with signatures.
- `/health` and `/health/ready` for Railway health checks.
- Migrations run as a release step (`prisma migrate deploy`) before the new api/worker version starts.
- Graceful shutdown: stop accepting HTTP, drain Socket.IO, let BullMQ finish active jobs.
- Photo URLs: the bucket is private. Every photo URL returned by the API is a signed GET URL (default 1 hour) with an unguessable object key, so a trip switching to private, a deleted photo, or a block takes effect without leaving working public links behind.
