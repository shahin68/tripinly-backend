# Tripinly — Data Model

PostgreSQL 16 with PostGIS. Prisma schema is the implementation; this file is the intent. Points are stored as plain `lat`/`lng` columns that Prisma reads and writes, plus a `location geography(Point, 4326)` column **generated** from them (`GENERATED ALWAYS AS … STORED`, written by hand in the migration). `location` is declared in Prisma as `Unsupported("geography(Point,4326)")?` with a matching `dbgenerated` default, never written by the app, and queried with `$queryRaw`.

All tables have `id uuid` (primary key) and `createdAt`; mutable tables also have `updatedAt`. Foreign keys noted as → table.

## Identity

**users**
- `username` (unique, lowercase, null until onboarding), `usernameChangedAt` (last change after onboarding; one change per 30 days), `displayName`, `birthDate` (date), `locale` (BCP 47, e.g. `hu-HU`)
- `defaultTripVisibility` (`public` | `private`, default `public`)
- `role` (`user` | `admin`), `status` (`active` | `suspended` | `deleting`)
- `onboardedAt` (null until profile + consents complete)

**auth_identities** — user → users, `provider` (`google` | `apple` | `dev`; `dev` only exists where `DEV_AUTH_ENABLED`), `providerSubject`, `email` (as given by provider), `appleRefreshToken` (encrypted, needed to revoke on deletion). Unique (`provider`, `providerSubject`).

**refresh_tokens** — user → users, `tokenHash`, `familyId`, `expiresAt`, `revokedAt`, `replacedById`, `deviceLabel`.

**consents** — user → users, `documentType` (`terms` | `privacy` | `marketing`), `version`, `locale`, `grantedAt`, `withdrawnAt`.

**legal_documents** — `documentType`, `version`, `locale`, `url`, `publishedAt`, `requiresReconsent`.

**devices** — user → users, `fcmToken` (unique), `platform` (`ios` | `android`), `locale`, `lastSeenAt`.

**username_holds** — `username`, `releasedAt` (freed handles reserved for 30 days).

## Trips

**trips**
- owner → users, `title`, `startDate`, `endDate` (both nullable; with a start date, `endDate = startDate + days − 1`, kept in sync on every day or date change), `visibility`
- `copiedFromTripId` → trips (nullable, `ON DELETE SET NULL`)
- `likeCount`, `copyCount` (denormalized, maintained in the same transaction or by job)
- `hiddenAt` (moderation)

**trip_members** — trip → trips, user → users, `role` (`owner` | `editor`), `addedById` (→ users, `SET NULL`). Unique (`tripId`, `userId`). The owner also has a row.

**trip_days** — trip → trips, `position` (0-based, contiguous). Unique (`tripId`, `position`). No stored date: a day's date is `trip.startDate + position`, or none for undated trips ("Day n").

**trip_invites** — trip → trips, `tokenHash` (SHA-256; unique), `createdById`, `expiresAt`, `revokedAt`.

## Places and markers

**places**
- `name`, `normalizedName`, `searchText` (normalized name plus every `name:<lang>` variant, for search), `names` (json, `name:<lang>` from OSM), `category` (`cafe` | `restaurant` | `bar` | `attraction` | `museum` | `historic` | `park` | `nature` | `landmark` | `other`), `lat`, `lng`, `location geography(Point)` (generated)
- `source` (`osm` | `user`), `osmType` (`node` | `way` | `relation`), `osmId` (bigint). Unique (`osmType`, `osmId`) (nulls don't collide). A `user` place created from a Photon result carries the OSM ids, so the import later recognises it (and leaves it alone).
- `osmRegion` (Geofabrik region of the last import that saw it; used to deactivate what a region no longer has)
- `tags` (json subset: website, opening_hours, cuisine, wikidata), `isActive`, `importedAt` (last time an import inserted or changed the row)
- `popularity` (int, denormalized: likes on public markers + direct place likes)
- GiST index on `location`; index on `popularity desc`; partial GiST index on `location WHERE popularity > 0`; GIN trigram indexes on `normalizedName` and `searchText` (extension `pg_trgm`); indexes on `category` and `osmRegion`.
- **Listing rule:** only `osm` places and places with `popularity > 0` appear in in-view, search, nearby and popular. Any other `user` place (a custom pin, possibly from a private trip) is visible only to people who can see a marker at it, including through `GET /places/{id}` and when picked by `placeId`.
- **No Google data** in this table (see `10-maps-places-routing.md`).

**osm_import_runs** — `region`, `status` (`running` | `succeeded` | `degraded` = deactivation skipped because the extract shrank > 20% | `failed`), `extractAt` (the extract's Last-Modified), `seen`, `inserted`, `updated`, `deactivated`, `error` (short operator message), `startedAt`, `finishedAt`.

**markers**
- day → trip_days, `tripId` (denormalized for access checks), place → places (`RESTRICT`: places with markers are never deleted)
- `name`, `lat`, `lng`, `location geography(Point)` (generated), `time` (nullable `HH:mm`), `position` (0-based, contiguous per day)
- `coverPhotoId` → photos (nullable, unique, `SET NULL`): always a ready photo of this marker
- `createdById` → users (nullable, `ON DELETE SET NULL`)
- `copiedFromMarkerId` → markers (nullable, `SET NULL`)
- `likeCount`, `commentCount`, `hiddenAt`

**photos**
- marker → markers (`CASCADE`), `tripId` (denormalized, `CASCADE`), `uploaderId` → users (`RESTRICT`: account deletion removes the user's photos and their files first), `position` (gallery order; new photos go last, reorder renumbers)
- Storage keys derive from the id: `photos/{id}/original` (re-encoded without metadata once processed), `photos/{id}/thumb.webp` (256 px square), `photos/{id}/display.webp` (≤ 1600 px). Deleting the prefix `photos/{id}/` deletes every file.
- `width`, `height` (upright, after EXIF rotation), `mimeType`, `bytes` (declared at upload)
- `status` (`pending_upload` | `processing` | `ready` | `failed`), `likeCount`, `hiddenAt`
- Pending and failed photos are removed with their files after 24 h (hourly job).

## Social

**comments** — marker → markers, author → users, `body`, `likeCount`, `hiddenAt`, `deletedAt`.

**likes** — user → users, `targetType` (`trip` | `marker` | `photo` | `comment` | `place`), `targetId`. Unique (`userId`, `targetType`, `targetId`). Index (`targetType`, `targetId`).

**blocks** — `blockerId`, `blockedId`. Unique pair. Queries check both directions.

**reports** — `reporterId` (nullable after reporter deletion), `targetType` (`user` | `trip` | `marker` | `photo` | `comment`), `targetId`, `reason` (`spam` | `harassment` | `nudity` | `violence` | `hate` | `other`), `details`, `status` (`open` | `actioned` | `dismissed`), `reviewedById`, `reviewedAt`, `action`.

## Notifications and billing

**notifications** — recipient → users, `type`, `actorId` (nullable), `tripId`, `markerId`, `payload` (json), `groupKey` (for grouped likes), `count`, `readAt`.

**entitlements** — user → users, `feature` (`best_route_realtime`), `source` (store/provider), `expiresAt`, `externalRef`.

## Deletion behaviour (FK summary)

| Relation | On user deletion |
|---|---|
| trips owned | delete (cascades days, markers, photos, comments, likes on them, invites) |
| trip_members rows | delete |
| markers created in others' trips | keep, `createdById = null` |
| photos uploaded anywhere | delete rows and storage objects |
| comments written anywhere | delete |
| likes given | delete, recompute counts |
| copies others made (`copiedFrom…`) | keep, link set null |
| reports filed | keep report, `reporterId = null` |
| notifications, devices, tokens, identities, blocks, entitlements | delete |

Storage-object deletion runs as a job after the database transaction commits.

## Indexes worth remembering

- `trips (visibility, likeCount desc)` for Explore; partial index `WHERE visibility = 'public' AND hiddenAt IS NULL`.
- `markers (dayId, position)`, `markers (placeId)`, `markers (tripId)`.
- GiST on `places.location` and `markers.location`.
- `users (username)` with `text_pattern_ops` for prefix search.
