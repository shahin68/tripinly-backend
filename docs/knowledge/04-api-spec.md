# Tripinly — API Spec

REST over HTTPS, JSON, base path `/v1`. The OpenAPI document generated from the code (`/v1/openapi.json`) is what the KMP client consumes. Swagger UI is served at `/v1/docs` on local and staging (not on production, decided by `DEPLOY_ENV`). This file describes intent and conventions.

## Conventions

- **Auth:** `Authorization: Bearer <accessToken>` on everything except `/auth/*`, `/legal/*`, `/health` and public share previews.
- **Language:** `Accept-Language` header selects the locale for error messages and any server-rendered text; falls back to the user's `locale`, then `en`.
- **Naming:** JSON fields in `camelCase`; paths in `kebab-case`, plural nouns.
- **IDs:** UUID strings. **Timestamps:** ISO 8601 UTC. **Dates:** `YYYY-MM-DD`. **Coordinates:** `{ "lat": 48.2, "lng": 16.37 }`.
- **Pagination:** cursor based. Request `?cursor=&limit=` (default 20, max 50). Response `{ "items": [...], "nextCursor": "..." | null }`.
- **Errors:**
  ```json
  { "error": { "code": "TRIP_NOT_FOUND", "message": "localized text", "details": {} } }
  ```
  `code` is stable and documented; clients switch on `code`, never on `message`. Validation errors use `VALIDATION_FAILED` with per-field `details`.
- **Status codes:** 200/201/204 success, 400 validation, 401 unauthenticated, 403 forbidden, 404 not found (also used for private resources the caller can't see — never reveal existence), 409 conflict (e.g. username taken), 422 domain rule violated, 429 rate limited.
- **Idempotency:** likes and unlikes are idempotent. `POST` creating content (trips, trip copy, days, markers, add-to-trip, marker copy, comments, invites) accepts an optional `Idempotency-Key` header: a client-generated UUID, new per user action and reused on its retries. For 24 hours a retry with the same key and the same request returns the first response with the header `Idempotent-Replayed: true` and creates nothing. The same key with a different request → 422 `IDEMPOTENCY_KEY_REUSED`; while the first request is still running → 409 `IDEMPOTENCY_KEY_IN_PROGRESS`; a malformed key (not 1–255 visible ASCII characters) → 400 `VALIDATION_FAILED`. Failed requests don't keep the key, so a retry runs again. Keys are per user. `upload-url` is left out because its response holds a signed URL; `POST /reports` already answers a repeat with the existing report.
- **Rate limits:** every route is limited per user (per IP when signed out), default 120 requests/minute; auth routes 20/minute per IP. Search, comment and upload endpoints get tighter limits as they are built.

## Endpoints

### Auth
| Method | Path | Notes |
|---|---|---|
| POST | `/auth/google` | Body: Google ID token. Returns tokens + `onboardingRequired` |
| POST | `/auth/apple` | Body: Apple identity token + authorization code (for revocation later) + optional `givenName`/`familyName` (Apple sends the name only on first sign-in) |
| POST | `/auth/dev` | Local and staging only (`DEV_AUTH_ENABLED`; 404 otherwise). When `DEV_AUTH_SECRET` is set, the `X-Dev-Auth-Secret` header must match or the answer is 404. Body: `subject`, optional `name` |
| DELETE | `/auth/dev/accounts?subject=…` or `?username=…` | Test-account cleanup, same switch and secret as `/auth/dev`. Exactly one of `subject` (a developer account, case-sensitive) or `username` (any account, `@` optional), else 400 `VALIDATION_FAILED`; 404 when nothing matches. Runs the full account deletion without a fresh sign-in and frees the username at once (no 30-day hold). 202 `{ "status": "deleting" }` |
| POST | `/auth/refresh` | Body: `refreshToken`. Rotates refresh token; reuse of an old token revokes the whole family, except within 30 s of its rotation while the newer token is unused (a lost answer): then a new pair is returned |
| POST | `/auth/logout` | Body: `refreshToken`, optional `fcmToken`. Revokes the session and removes that device. No access token needed; always 204 |

Sign-in and refresh return **AuthTokens**: `accessToken`, `accessTokenExpiresAt`, `refreshToken`, `refreshTokenExpiresAt`, `onboardingRequired`. Google body: `idToken`. A provider that isn't configured answers 503 `SERVICE_UNAVAILABLE` with `details.provider`; an invalid provider token answers 401 `UNAUTHENTICATED` with `details.reason = invalid_identity_token`.

**Onboarding gate:** until the profile (username, displayName, birthDate) and the current Terms and Privacy consents are complete, only `GET/PATCH /me`, `GET/POST /me/consents`, `PUT/DELETE /me/devices/{fcmToken}`, `GET /users/check-username`, `DELETE /me` and `GET/POST /me/export` work; everything else answers 403 `ONBOARDING_INCOMPLETE`. When a new document version requires re-consent, the same routes stay open and the rest answer 403 `CONSENT_REQUIRED`.

### Legal and consent
| Method | Path | Notes |
|---|---|---|
| GET | `/legal/documents` | Current versions and URLs per locale |
| GET | `/me/consents` | Latest record per document + `missingRequired[]` |
| POST | `/me/consents` | Body: `documentType`, `version`, `locale`, `granted`. Granting needs the current version (else 400 with `fields.version = ['notCurrentVersion']`). Returns the same shape as GET |

### Me
| Method | Path | Notes |
|---|---|---|
| GET | `/me` | Profile, settings, onboarding state, entitlements |
| PATCH | `/me` | Display name, username (once per 30 days after onboarding, else 422 `USERNAME_CHANGE_TOO_SOON` with `details.availableAt`), birth date (onboarding only; under 16 → 422 `AGE_REQUIREMENT_NOT_MET` and the account is deleted), locale, `defaultTripVisibility` |
| GET | `/me/stats` | `{ tripCount (own + collaborating), markerCount (created by me), photoCount }` |
| GET | `/me/trips` | Owned + collaborating, most recently changed first (marker and day edits count), cursor paginated; each item has `role`, `coverThumbUrl` (first cover photo in the trip, or null), `dayCount`, `markerCount` |
| PUT | `/me/devices/{fcmToken}` | Register/refresh push device. Body: `platform` (`android`\|`ios`), `locale` |
| DELETE | `/me/devices/{fcmToken}` | |
| POST | `/me/export` | Starts the GDPR export → 202 **DataExport**; emails a download link valid 7 days when ready. One at a time (a pending export is returned again, 202) and one per 24 h (429 `RATE_LIMITED`, `details.retryAfterSeconds`, `Retry-After`). 503 `SERVICE_UNAVAILABLE` while storage isn't configured |
| GET | `/me/export` | Latest **DataExport** (404 when none): `id`, `status` (`pending`\|`ready`\|`failed`\|`expired`), `createdAt`, `readyAt`, `expiresAt`, `bytes`, `downloadUrl` (signed, only while ready, valid until `expiresAt`; never log it) |
| DELETE | `/me` | Starts account deletion (see `account-deletion` skill) → 202 `{ "status": "deleting" }`. Needs a Google/Apple sign-in in the last 10 minutes, else 403 `REAUTH_REQUIRED` (sign in again, then retry). Signs out everywhere at once: tokens stop working and sockets close. Everything else runs in the background; a confirmation email follows |

### Users
| Method | Path | Notes |
|---|---|---|
| GET | `/users/check-username?username=` | `{ username (normalized), available, reason? (invalid\|taken) }`. Allowed during onboarding |
| GET | `/users/search?q=` | Prefix search (2–50 chars) on username and display name; onboarded users only, never yourself or anyone with a block either way. `{ items: [user summary] }`, max 20 |
| GET | `/users/{username}?cursor=&limit=` | Public profile: `{ user, publicTripCount, trips[] (trip summaries, most recently changed first), nextCursor }`. Unknown, or a block either way → 404 |
| POST | `/users/{id}/block` | 204, idempotent. Also removes each user from the other's trips as an editor |
| DELETE | `/users/{id}/block` | 204, idempotent |
| GET | `/me/blocks` | Users I blocked, cursor paginated |

### Trips
| Method | Path | Notes |
|---|---|---|
| POST | `/trips` | `title`, optional `startDate`/`endDate` (one day per date, max 20; `endDate` needs `startDate`; no dates → one "Day 1"), optional `destination` `{ name (1–200), location { lat, lng } }` (e.g. a city from `/places/search`), `visibility` (default: my `defaultTripVisibility`), `memberUsernames` (≤ 20, added as editors; unknown → 400 `fields["memberUsernames.<i>"] = ["notFound"]`, ones I blocked → `["blocked"]`). Max 200 owned trips |
| GET | `/trips/{id}` | Trip with days, markers (cover thumbnail URLs), members, `copiedFrom` summary |
| PATCH | `/trips/{id}` | Owner: `title`, `visibility`, `destination` (null removes it), `startDate` (null removes both dates, days stay), `endDate` (resizes: adds empty days, removes trailing days only if empty, else 400 `fields.endDate = ["daysNotEmpty"]`) |
| DELETE | `/trips/{id}` | Owner |
| POST | `/trips/{id}/copy` | "Add to my trips" → 201 with the new trip (title, dates, destination, days, visible markers; my default visibility; `copiedFrom` set). Own or private trip → 403 `TRIP_NOT_COPYABLE`; a private trip I'm not in → 404. Counts toward 200 owned trips |
| GET | `/explore/trips?cursor=&limit=` | Public trips from others with at least one marker, ranked by `(likes + 2 × copies) / (age days + 2)^1.5`, newest on ties. Trip summaries; `nextCursor` continues the same ranking |

### Days
| Method | Path | Notes |
|---|---|---|
| POST | `/trips/{id}/days` | Append a day (owner or editor); extends `endDate` for dated trips. Max 20 |
| DELETE | `/days/{id}` | Deletes its markers; later days move up and `endDate` shrinks. The last day can't be deleted (400 `fields.id = ["lastDay"]`) |
| PUT | `/days/{id}/marker-order` | Body: `markerIds`, exactly the day's markers in the new order (else 400 `fields.markerIds = ["mustMatchDayMarkers"]`). Returns `{ dayId, markerIds }` |
| POST | `/days/{id}/optimize?mode=&apply=` | Best route, first marker fixed → 200 `{ dayId, markerIds, mode (straight_line\|travel_time), savedMinutes (travel_time only, else null), degraded, applied }`. Free: straight-line distance. With `best_route_realtime`: openrouteservice travel times for `mode` (default walking); if they're unavailable, straight line with `degraded: true`. Anyone who can see the trip gets a proposal; `apply=true` (owner or editor) saves it and emits `markers.reordered`. Up to 25 markers (422 `LIMIT_REACHED`, `resource: optimizeMarkers`) |

### Members and invites
| Method | Path | Notes |
|---|---|---|
| POST | `/trips/{id}/members` | Owner adds by `username` → member `{ user, role }`; idempotent. Someone I blocked → 403 `USER_BLOCKED`; someone who blocked me or unknown → 404. Max 50 members |
| DELETE | `/trips/{id}/members/{userId}` | Owner removes, or editor removes self (leave). The owner can't be removed (403) |
| POST | `/trips/{id}/invites` | Owner creates invite link → `{ id, url, token, expiresAt, createdAt }` (the token is shown only here). Valid 7 days, reusable, max 20 active |
| GET | `/trips/{id}/invites` | Owner lists active invites (`id`, `expiresAt`, `createdAt`) so they can be revoked |
| DELETE | `/trips/{id}/invites/{inviteId}` | Revoke; idempotent |
| GET | `/invites/{token}` | Preview: `tripId`, `title`, `owner`, dates, `expiresAt`, `alreadyMember`. 410 `INVITE_EXPIRED` when expired or revoked; 404 if unknown or the owner and I have a block |
| POST | `/invites/{token}/accept` | Join as editor → the trip. Idempotent for members |

### Markers
| Method | Path | Notes |
|---|---|---|
| POST | `/days/{id}/markers` | Optional client-chosen `id` (UUID) so the app can show and edit the marker before the response; a taken ID → 409 `ID_CONFLICT` (a client that gets this for its own retried create treats the marker as saved). Either `placeId` (optional `name` overrides the place name), or `name` + `location` (+ optional `osmType`/`osmId` from a Photon result, `category` for a new place). Optional `time` (`HH:mm`), `position` (insert; appended when omitted). Unknown fields such as a Google place ID → 400. Max 50 per day |
| DELETE | `/days/{id}/markers` | Clears the day: deletes all its markers in one request (editor or owner) → 204, also when already empty; the day stays. Moderated (hidden) markers stay. Emits `marker.deleted` per marker |
| GET | `/markers/{id}` | Marker with photos, like state, comment count |
| PATCH | `/markers/{id}` | `name`, `time` (null clears), `placeId` or `location` (re-matches the place), `dayId` (another day of the same trip, else 400 `fields.dayId = ["notInTrip"]`), `position` |
| DELETE | `/markers/{id}` | |
| POST | `/markers/{id}/copy` | Body: `dayId` (a day of a trip I own or edit), optional `position` → 201 with the new marker (same name, location, time, place; no photos, comments or likes). Marker of my own or a private trip → 403 `TRIP_NOT_COPYABLE` |

### Photos
| Method | Path | Notes |
|---|---|---|
| POST | `/markers/{id}/photos/upload-url` | Body: `mimeType` (`image/jpeg`\|`image/png`\|`image/webp`, else 415 `UNSUPPORTED_MEDIA_TYPE`), `bytes` (≤ 15 MB, else 413 `UPLOAD_TOO_LARGE`). Editors and owner; 30 photos per marker (422 `PHOTO_LIMIT_REACHED`); 60/min per user. Returns `{ photo, uploadUrl, uploadHeaders, expiresAt }`: PUT the file to `uploadUrl` within 10 minutes with exactly `uploadHeaders` (`Content-Type`, `Content-Length`). 503 `SERVICE_UNAVAILABLE` while storage isn't configured |
| POST | `/photos/{id}/complete` | The uploader confirms → 202 with the photo (`processing`); `photo.ready` follows. Not uploaded yet or a different size → 400 (`upload: notUploaded \| sizeMismatch`). Repeating it returns the photo as is |
| GET | `/markers/{id}/photos` | Gallery in order (not paginated; ≤ 30). Viewers get ready photos; members also processing and failed ones |
| PUT | `/markers/{id}/photo-order` | Body: `photoIds`, exactly the marker's processing and ready photos (400 `photoIds: mustMatchMarkerPhotos`). Returns the gallery |
| PUT | `/markers/{id}/cover` | Body: `photoId` (a ready photo of this marker, else 400 `photoId: notFound \| notReady`). Returns the marker. The first ready photo becomes the cover automatically |
| DELETE | `/photos/{id}` | Uploader (even after leaving the trip), trip owner or editor. A deleted cover passes to the next ready photo |

### Comments and likes
| Method | Path | Notes |
|---|---|---|
| GET | `/markers/{id}/comments?cursor=&limit=` | Oldest first. Comments from people with a block with me are left out |
| POST | `/markers/{id}/comments` | Body: `body` (trimmed, 1–1000 chars) → 201 comment. Members, or anyone for a public trip; not on a marker created by someone I have a block with (403). 30/min per user |
| DELETE | `/comments/{id}` | 204. The author (even after leaving the trip) or the trip owner; others 403 |
| PUT | `/likes/{targetType}/{targetId}` | `trip`, `marker`, `photo` (ready only), `comment`, `place` → `{ targetType, targetId, liked, likeCount }` (a place's `likeCount` is its popularity). Idempotent. Not visible, hidden, or across a block → 404 |
| DELETE | `/likes/{targetType}/{targetId}` | Same response with `liked: false`. Idempotent |

### Discovery
| Method | Path | Notes |
|---|---|---|
| GET | `/places/in-view?bbox=minLng,minLat,maxLng,maxLat&zoom=&categories=&limit=` | Places for the visible map area: `{ places[], clusters[], attribution }`. Tripinly places first, OSM places from zoom 14 (from zoom 10 only notable ones, with a Wikidata entry, while Tripinly places are fewer than `limit`), clusters below zoom 14 when there are more than `limit` (10–200, default 100). Picks don't change while the view pans within the same area. A bbox too large for the zoom → 400 `BBOX_TOO_LARGE` |
| GET | `/places/search?q=&lat=&lng=` | `{ items[], attribution }`: our places (`source: "place"`, with `id`) then Photon results (`source: "photon"`, no `id`; send name + location + `osmType`/`osmId` when adding the marker). `q` 1–100 chars (one letter searches Photon only); 60 requests/min per user |
| GET | `/places/nearby?lat=&lng=&radiusKm=&cursor=&limit=` | Popular places around the user (radius 0.1–50 km, default 5), each with `distanceMeters`; the first page is topped up with OSM sights when fewer than 10 are in range. Location not stored |
| GET | `/places/popular?bbox=…&excludeTripId=&limit=` | Tripinly places only in the visible area (bbox side ≤ 5°), excluding places already in the trip |
| GET | `/places/{id}` | Place detail: source, OSM ids, tags (website, openingHours, cuisine, wikidata), `photoThumbUrls` (up to 10 from public trips, most liked first), `attribution` |
| POST | `/places/{id}/add-to-trip` | Body: `dayId`, optional `time`, `position` → new marker (same rules as `POST /days/{id}/markers`) |

### Routing
| Method | Path | Notes |
|---|---|---|
| GET | `/routes?from=lat,lng&to=lat,lng&mode=walking\|cycling\|driving&categories=&excludeTripId=` | Route line + places along the way (leaving out `excludeTripId`'s places; I must be able to see that trip) |
| GET | `/days/{id}/route?mode=&categories=` | Route through the day's visible markers in order + places along the way (not the trip's own). `route` is null with fewer than two markers |

Both return `{ route: { polyline, distanceMeters, durationSeconds, legs[] → { fromMarkerId, toMarkerId, distanceMeters, durationSeconds } }, alongTheWay[] → { place, distanceFromRouteMeters, positionAlongRoute (0–1), etaFromStartSeconds }, degraded, attribution }`. `degraded: true` means routing isn't available right now (daily quota used up, or not configured): the route is straight lines with times estimated from typical speeds. An openrouteservice failure (timeout, 429, 5xx) answers 503 `ROUTING_UNAVAILABLE`. Route lines are free for everyone.

See `10-maps-places-routing.md` for response shape, buffers and caching.

### Sharing
| Method | Path | Notes |
|---|---|---|
| GET | `/share/trips/{id}` | Share URL + preview data (respects visibility) |
| GET | `/share/markers/{id}` | |

### Notifications
| Method | Path | Notes |
|---|---|---|
| GET | `/notifications` | Paginated (`cursor`, `limit`), newest first → `{ items, nextCursor, unreadCount }`. Item: `id`, `type`, `actor` (user summary or null), `trip` (`{ id, title }` or null), `markerId`, `count`, `title`, `body` (localized by `Accept-Language`, else the saved locale; the same text as the push), `deepLink`, `read`, `createdAt`, `updatedAt`. Hides entries caused by someone I have a block with and entries about trips I can no longer see |
| POST | `/notifications/read` | Body `{ "ids": [...] }` (up to 100) or `{ "all": true }` → 204. Foreign or unknown ids are ignored |
| GET/PATCH | `/me/notification-settings` | `{ commentOnMarker, addedToTrip, tripChangedByCollaborator, likesGrouped }`, all `true` by default; PATCH sends only what changes. Off stops the push, not the in-app entry |

Real time: Socket.IO namespace `/v1/realtime`, see `05-realtime-and-notifications.md`.

### Moderation
| Method | Path | Notes |
|---|---|---|
| POST | `/reports` | Body: `targetType` (`user`\|`trip`\|`marker`\|`photo`\|`comment`), `targetId`, `reason` (`spam`\|`harassment`\|`nudity`\|`violence`\|`hate`\|`other`), optional `details` (≤ 1000) → 201 **Report** `{ id, targetType, targetId, reason, status, createdAt }`. An open report by the same user on the same target answers 200 with it. The target must be visible to the caller (404 otherwise); a user can be reported even across a block. 20 per day (429 `RATE_LIMITED`) |
| GET | `/admin/reports?status=&cursor=&limit=` | Admin only (403 `FORBIDDEN` otherwise). `status` defaults to `open`; oldest first. Item: the report plus `details`, `action`, `reviewedAt`, `reporter` (`{ id, username }` or null), `openReportCount` (open reports on the same target), `target` `{ exists, owner { id, username } \| null, text (title, name, comment body or display name), thumbUrl (photos), tripId, hidden }` |
| PATCH | `/admin/reports/{id}` | Admin only. Body `{ action: dismiss\|hide_content\|suspend_user\|delete_content, note? }` → the updated report. Resolves every open report on the same target and writes the audit log. `hide_content` / `delete_content` need a content target (400 `VALIDATION_FAILED` for a user); `suspend_user` suspends the reported user or the content's author (403 for an admin) |

### Ops
| Method | Path | Notes |
|---|---|---|
| GET | `/health` | Liveness (no auth). Full path `/v1/health` |
| GET | `/health/ready` | DB + Redis reachable and every migration this build ships with applied (none failed); `checks: { database, redis, migrations }`, 503 `SERVICE_UNAVAILABLE` with `details.checks` otherwise. Full path `/v1/health/ready` |
| GET | `/.well-known/assetlinks.json`, `/.well-known/apple-app-site-association` | Android App Links / iOS Universal Links for invite and share URLs (served on the app-link domain) |

## Key response shapes

Field names the client relies on (full schemas in OpenAPI):

- **Trip** (`GET /trips/{id}`): `id`, `title`, `startDate`, `endDate`, `destination` (`{ name, location }` or null; the client opens the map there while the trip has no markers), `visibility`, `owner` (user summary), `myRole` (`owner`\|`editor`\|`viewer`), `members[]` → `{ user, role }` (owner first; people with a block with me are left out), `likeCount`, `likedByMe`, `copyCount`, `copiedFrom` (`{ tripId, owner: user summary }` or null), `days[]` → `{ id, position, date (startDate + position, or null), markers[] }`, `createdAt`, `updatedAt`.
- **Marker**: `id`, `tripId`, `dayId`, `placeId`, `name`, `location`, `time` (`HH:mm` or null), `position`, `coverPhotoId`, `coverThumbUrl`, `photoCount`, `likeCount`, `likedByMe`, `commentCount`, `createdBy` (user summary, or null after account deletion or across a block), `createdAt`, `updatedAt`.
- **Photo**: `id`, `markerId`, `status` (`pending_upload`\|`processing`\|`ready`\|`failed`), `thumbUrl`, `displayUrl` (null until ready; signed, valid at least 1 h and unchanged within the hour so images cache), `width`, `height`, `position`, `likeCount`, `likedByMe`, `uploader` (null across a block), `createdAt`.
- **Trip summary** (My Trips, Explore, profiles): `id`, `title`, `startDate`, `endDate`, `visibility`, `owner`, `role` (`owner`\|`editor`\|`viewer`), `coverThumbUrl`, `dayCount`, `markerCount`, `likeCount`, `likedByMe`, `copyCount`, `updatedAt`.
- **Comment**: `id`, `markerId`, `body`, `author` (user summary), `likeCount`, `likedByMe`, `canDelete` (I wrote it or own the trip), `createdAt`.
- **User summary**: `id`, `username`, `displayName`.
- **Place** (in-view, popular, nearby, along-the-way): `id`, `name` (localized from OSM `name:<lang>` by `Accept-Language`), `category`, `location`, `isTripinly`, `likeCount`, `coverThumbUrl` (cover photo of the most liked marker there in a public trip, or null), `likedByMe`. Nearby adds `distanceMeters`. Search results: `source`, `id` (null for Photon), `name`, `category` (null for Photon), `location`, `isTripinly`, `likeCount`, `type` and `address` (Photon), `osmType`, `osmId`. Every places response carries `attribution: "© OpenStreetMap contributors"`.
- **Me**: profile fields, `onboarding` state, `defaultTripVisibility`, `locale`, `entitlements[]` (e.g. `best_route_realtime`).

## Stable error codes (starter set)

`UNAUTHENTICATED`, `TOKEN_EXPIRED`, `REFRESH_TOKEN_REUSED`, `ONBOARDING_INCOMPLETE`, `CONSENT_REQUIRED`, `AGE_REQUIREMENT_NOT_MET`, `USERNAME_TAKEN`, `USERNAME_INVALID`, `USERNAME_CHANGE_TOO_SOON` (422, `details.availableAt`), `VALIDATION_FAILED`, `NOT_FOUND`, `FORBIDDEN`, `TRIP_NOT_COPYABLE`, `USER_BLOCKED`, `INVITE_EXPIRED` (410), `PHOTO_LIMIT_REACHED`, `LIMIT_REACHED` (422, `details.resource` = `trips`\|`days`\|`markers`\|`members`\|`invites`\|`optimizeMarkers`, `details.max`), `UPLOAD_TOO_LARGE`, `UNSUPPORTED_MEDIA_TYPE`, `PREMIUM_REQUIRED`, `RATE_LIMITED` (429, `details.retryAfterSeconds`, `Retry-After` header), `ACCOUNT_SUSPENDED` (403: suspended; also on refresh), `REAUTH_REQUIRED` (403: `DELETE /me` without a sign-in in the last 10 minutes), `ROUTING_UNAVAILABLE`, `BBOX_TOO_LARGE` (400, `details.maxSpanDegrees`), `IDEMPOTENCY_KEY_REUSED` (422), `IDEMPOTENCY_KEY_IN_PROGRESS` (409), `ID_CONFLICT` (409: a client-chosen `id` on create already exists), `SERVICE_UNAVAILABLE` (503, e.g. `/health/ready` when a dependency is down), `INTERNAL_ERROR` (500, never carries internal details).

Add new codes here when you introduce them.
