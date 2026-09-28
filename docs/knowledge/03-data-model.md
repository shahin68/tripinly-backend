# Tripinly — Data Model

PostgreSQL 16 with PostGIS. Prisma schema is the implementation; this file is the intent. Spatial columns use `geography(Point, 4326)`, declared in Prisma as `Unsupported("geography(Point,4326)")` and queried with `$queryRaw`.

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
- owner → users, `title`, `startDate`, `endDate` (nullable), `visibility`
- `copiedFromTripId` → trips (nullable, `ON DELETE SET NULL`)
- `likeCount`, `copyCount` (denormalized, maintained in the same transaction or by job)
- `hiddenAt` (moderation)

**trip_members** — trip → trips, user → users, `role` (`owner` | `editor`), `addedById`. Unique (`tripId`, `userId`). The owner also has a row.

**trip_days** — trip → trips, `position` (0-based), optional `date`. Unique (`tripId`, `position`).

**trip_invites** — trip → trips, `tokenHash`, `createdById`, `expiresAt`, `revokedAt`.

## Places and markers

**places**
- `name`, `normalizedName`, `names` (json, `name:<lang>` from OSM), `category` (`cafe` | `restaurant` | `bar` | `attraction` | `museum` | `historic` | `park` | `nature` | `landmark` | `other`), `location geography(Point)`
- `source` (`osm` | `user`), `osmType` (`node` | `way` | `relation`), `osmId` (bigint). Unique (`osmType`, `osmId`) where not null.
- `tags` (json subset: website, opening_hours, cuisine, wikidata), `isActive`, `importedAt`
- `popularity` (int, denormalized: likes on public markers + direct place likes)
- GiST index on `location`; index on `popularity desc`; partial GiST index on `location WHERE popularity > 0`; GIN trigram index on `normalizedName` (extension `pg_trgm`); index on `category`.
- **No Google data** in this table (see `10-maps-places-routing.md`).

**osm_import_runs** — `region`, `sourceFile`, `sourceTimestamp`, `startedAt`, `finishedAt`, `inserted`, `updated`, `deactivated`, `status`.

**markers**
- day → trip_days, `tripId` (denormalized for access checks), place → places
- `name`, `location geography(Point)`, `time` (nullable `HH:mm`), `position`
- `coverPhotoId` → photos (nullable)
- `createdById` → users (nullable, `ON DELETE SET NULL`)
- `copiedFromMarkerId` → markers (nullable, `SET NULL`)
- `likeCount`, `commentCount`, `hiddenAt`

**photos**
- marker → markers, `uploaderId` → users, `position`
- `storageKeyOriginal`, `storageKeyThumb`, `storageKeyDisplay`, `width`, `height`, `mimeType`, `bytes`
- `status` (`pending_upload` | `processing` | `ready` | `failed`), `likeCount`, `hiddenAt`

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
