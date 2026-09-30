# Tripinly — API Spec

REST over HTTPS, JSON, base path `/v1`. The OpenAPI document generated from the code (`/v1/openapi.json`) is what the KMP client consumes; this file describes intent and conventions.

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
- **Idempotency:** likes and unlikes are idempotent. `POST` creating content accepts an optional `Idempotency-Key` header.
- **Rate limits:** every route is limited per user (per IP when signed out), default 120 requests/minute; auth routes 20/minute per IP. Search, comment and upload endpoints get tighter limits as they are built.

## Endpoints

### Auth
| Method | Path | Notes |
|---|---|---|
| POST | `/auth/google` | Body: Google ID token. Returns tokens + `onboardingRequired` |
| POST | `/auth/apple` | Body: Apple identity token + authorization code (for revocation later) + optional `givenName`/`familyName` (Apple sends the name only on first sign-in) |
| POST | `/auth/dev` | Local development only (`DEV_AUTH_ENABLED`; 404 otherwise). Body: `subject`, optional `name` |
| POST | `/auth/refresh` | Body: `refreshToken`. Rotates refresh token; reuse of an old token revokes the whole family |
| POST | `/auth/logout` | Body: `refreshToken`, optional `fcmToken`. Revokes the session and removes that device. No access token needed; always 204 |

Sign-in and refresh return **AuthTokens**: `accessToken`, `accessTokenExpiresAt`, `refreshToken`, `refreshTokenExpiresAt`, `onboardingRequired`. Google body: `idToken`. A provider that isn't configured answers 503 `SERVICE_UNAVAILABLE` with `details.provider`; an invalid provider token answers 401 `UNAUTHENTICATED` with `details.reason = invalid_identity_token`.

**Onboarding gate:** until the profile (username, displayName, birthDate) and the current Terms and Privacy consents are complete, only `GET/PATCH /me`, `GET/POST /me/consents`, `PUT/DELETE /me/devices/{fcmToken}` and `GET /users/check-username` work; everything else answers 403 `ONBOARDING_INCOMPLETE`. When a new document version requires re-consent, the same routes stay open and the rest answer 403 `CONSENT_REQUIRED`.

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
| POST | `/me/export` | Starts GDPR export job; email when ready |
| DELETE | `/me` | Starts account deletion (see `account-deletion` skill) |

### Users
| Method | Path | Notes |
|---|---|---|
| GET | `/users/check-username?username=` | `{ username (normalized), available, reason? (invalid\|taken) }`. Allowed during onboarding |
| GET | `/users/search?q=` | Prefix search (2–50 chars) on username and display name; onboarded users only, never yourself or anyone with a block either way. `{ items: [user summary] }`, max 20 |
| GET | `/users/{username}` | Public profile + public trips |
| POST | `/users/{id}/block` | 204, idempotent. Also removes each user from the other's trips as an editor |
| DELETE | `/users/{id}/block` | 204, idempotent |
| GET | `/me/blocks` | Users I blocked, cursor paginated |

### Trips
| Method | Path | Notes |
|---|---|---|
| POST | `/trips` | `title`, optional `startDate`/`endDate` (one day per date, max 20; `endDate` needs `startDate`; no dates → one "Day 1"), `visibility` (default: my `defaultTripVisibility`), `memberUsernames` (≤ 20, added as editors; unknown → 400 `fields["memberUsernames.<i>"] = ["notFound"]`, ones I blocked → `["blocked"]`). Max 200 owned trips |
| GET | `/trips/{id}` | Trip with days, markers (cover thumbnail URLs), members, `copiedFrom` summary |
| PATCH | `/trips/{id}` | Owner: `title`, `visibility`, `startDate` (null removes both dates, days stay), `endDate` (resizes: adds empty days, removes trailing days only if empty, else 400 `fields.endDate = ["daysNotEmpty"]`) |
| DELETE | `/trips/{id}` | Owner |
| POST | `/trips/{id}/copy` | "Add to my trips". Public, not own. Returns the new trip |
| GET | `/explore/trips` | Public trips from others, ranked |

### Days
| Method | Path | Notes |
|---|---|---|
| POST | `/trips/{id}/days` | Append a day (owner or editor); extends `endDate` for dated trips. Max 20 |
| DELETE | `/days/{id}` | Deletes its markers; later days move up and `endDate` shrinks. The last day can't be deleted (400 `fields.id = ["lastDay"]`) |
| PUT | `/days/{id}/marker-order` | Body: `markerIds`, exactly the day's markers in the new order (else 400 `fields.markerIds = ["mustMatchDayMarkers"]`). Returns `{ dayId, markerIds }` |
| POST | `/days/{id}/optimize` | Best route. Free: straight-line. Premium: travel times. Returns proposed order + `mode` + optional `savedMinutes`; `?apply=true` persists |

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
| POST | `/days/{id}/markers` | Either `placeId` (optional `name` overrides the place name), or `name` + `location` (+ optional `osmType`/`osmId` from a Photon result, `category` for a new place). Optional `time` (`HH:mm`), `position` (insert; appended when omitted). Unknown fields such as a Google place ID → 400. Max 50 per day |
| GET | `/markers/{id}` | Marker with photos, like state, comment count |
| PATCH | `/markers/{id}` | `name`, `time` (null clears), `placeId` or `location` (re-matches the place), `dayId` (another day of the same trip, else 400 `fields.dayId = ["notInTrip"]`), `position` |
| DELETE | `/markers/{id}` | |
| POST | `/markers/{id}/copy` | Body: target `dayId` in one of my trips |

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
| GET | `/markers/{id}/comments` | Paginated, oldest first |
| POST | `/markers/{id}/comments` | |
| DELETE | `/comments/{id}` | Author or trip owner |
| PUT | `/likes/{targetType}/{targetId}` | `trip`, `marker`, `photo`, `comment`, `place` |
| DELETE | `/likes/{targetType}/{targetId}` | |

### Discovery
| Method | Path | Notes |
|---|---|---|
| GET | `/places/in-view?bbox=minLng,minLat,maxLng,maxLat&zoom=&categories=&limit=` | Places for the visible map area: `{ places[], clusters[], attribution }`. Tripinly places first, OSM places from zoom 14, clusters below zoom 14 when there are more than `limit` (10–200, default 100). A bbox too large for the zoom → 400 `BBOX_TOO_LARGE` |
| GET | `/places/search?q=&lat=&lng=` | `{ items[], attribution }`: our places (`source: "place"`, with `id`) then Photon results (`source: "photon"`, no `id`; send name + location + `osmType`/`osmId` when adding the marker). `q` 2–100 chars; 60 requests/min per user |
| GET | `/places/nearby?lat=&lng=&radiusKm=&cursor=&limit=` | Popular places around the user (radius 0.1–50 km, default 5), each with `distanceMeters`; the first page is topped up with OSM sights when fewer than 10 are in range. Location not stored |
| GET | `/places/popular?bbox=…&excludeTripId=&limit=` | Tripinly places only in the visible area (bbox side ≤ 5°), excluding places already in the trip |
| GET | `/places/{id}` | Place detail: source, OSM ids, tags (website, openingHours, cuisine, wikidata), `photoThumbUrls` (from the photos stage), `attribution` |
| POST | `/places/{id}/add-to-trip` | Body: `dayId`, optional `time`, `position` → new marker (same rules as `POST /days/{id}/markers`) |

### Routing
| Method | Path | Notes |
|---|---|---|
| GET | `/routes?from=lat,lng&to=lat,lng&mode=walking\|cycling\|driving&categories=` | Route line + places along the way |
| GET | `/days/{id}/route?mode=&categories=` | Route through the day's markers in order + places along the way |

See `10-maps-places-routing.md` for response shape, buffers and caching.

### Sharing
| Method | Path | Notes |
|---|---|---|
| GET | `/share/trips/{id}` | Share URL + preview data (respects visibility) |
| GET | `/share/markers/{id}` | |

### Notifications
| Method | Path | Notes |
|---|---|---|
| GET | `/notifications` | Paginated, newest first |
| POST | `/notifications/read` | Body: IDs or `all` |
| GET/PATCH | `/me/notification-settings` | Per-type push on/off |

### Moderation
| Method | Path | Notes |
|---|---|---|
| POST | `/reports` | Target type, ID, reason, details |
| GET | `/admin/reports` | Admin only, filter by status |
| PATCH | `/admin/reports/{id}` | Dismiss, hide content, suspend user |

### Ops
| Method | Path | Notes |
|---|---|---|
| GET | `/health` | Liveness (no auth). Full path `/v1/health` |
| GET | `/health/ready` | DB + Redis reachable; 503 `SERVICE_UNAVAILABLE` with `details.checks` otherwise. Full path `/v1/health/ready` |
| GET | `/.well-known/assetlinks.json`, `/.well-known/apple-app-site-association` | Android App Links / iOS Universal Links for invite and share URLs (served on the app-link domain) |

## Key response shapes

Field names the client relies on (full schemas in OpenAPI):

- **Trip** (`GET /trips/{id}`): `id`, `title`, `startDate`, `endDate`, `visibility`, `owner` (user summary), `myRole` (`owner`\|`editor`\|`viewer`), `members[]` → `{ user, role }` (owner first; people with a block with me are left out), `likeCount`, `likedByMe`, `copyCount`, `copiedFrom` (`{ tripId, owner: user summary }` or null), `days[]` → `{ id, position, date (startDate + position, or null), markers[] }`, `createdAt`, `updatedAt`.
- **Marker**: `id`, `tripId`, `dayId`, `placeId`, `name`, `location`, `time` (`HH:mm` or null), `position`, `coverPhotoId`, `coverThumbUrl`, `photoCount`, `likeCount`, `likedByMe`, `commentCount`, `createdBy` (user summary, or null after account deletion or across a block), `createdAt`, `updatedAt`.
- **Photo**: `id`, `markerId`, `status` (`pending_upload`\|`processing`\|`ready`\|`failed`), `thumbUrl`, `displayUrl` (null until ready; signed, valid at least 1 h and unchanged within the hour so images cache), `width`, `height`, `position`, `likeCount`, `likedByMe`, `uploader` (null across a block), `createdAt`.
- **User summary**: `id`, `username`, `displayName`.
- **Place** (in-view, popular, nearby, along-the-way): `id`, `name` (localized from OSM `name:<lang>` by `Accept-Language`), `category`, `location`, `isTripinly`, `likeCount`, `coverThumbUrl` (null until the photos stage), `likedByMe` (false until the social stage). Nearby adds `distanceMeters`. Search results: `source`, `id` (null for Photon), `name`, `category` (null for Photon), `location`, `isTripinly`, `likeCount`, `type` and `address` (Photon), `osmType`, `osmId`. Every places response carries `attribution: "© OpenStreetMap contributors"`.
- **Me**: profile fields, `onboarding` state, `defaultTripVisibility`, `locale`, `entitlements[]` (e.g. `best_route_realtime`).

## Stable error codes (starter set)

`UNAUTHENTICATED`, `TOKEN_EXPIRED`, `REFRESH_TOKEN_REUSED`, `ONBOARDING_INCOMPLETE`, `CONSENT_REQUIRED`, `AGE_REQUIREMENT_NOT_MET`, `USERNAME_TAKEN`, `USERNAME_INVALID`, `USERNAME_CHANGE_TOO_SOON` (422, `details.availableAt`), `VALIDATION_FAILED`, `NOT_FOUND`, `FORBIDDEN`, `TRIP_NOT_COPYABLE`, `USER_BLOCKED`, `INVITE_EXPIRED` (410), `PHOTO_LIMIT_REACHED`, `LIMIT_REACHED` (422, `details.resource` = `trips`\|`days`\|`markers`\|`members`\|`invites`, `details.max`), `UPLOAD_TOO_LARGE`, `UNSUPPORTED_MEDIA_TYPE`, `PREMIUM_REQUIRED`, `RATE_LIMITED` (429, `details.retryAfterSeconds`, `Retry-After` header), `ACCOUNT_SUSPENDED`, `REAUTH_REQUIRED`, `ROUTING_UNAVAILABLE`, `BBOX_TOO_LARGE` (400, `details.maxSpanDegrees`), `SERVICE_UNAVAILABLE` (503, e.g. `/health/ready` when a dependency is down), `INTERNAL_ERROR` (500, never carries internal details).

Add new codes here when you introduce them.
