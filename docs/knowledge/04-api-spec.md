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
| GET | `/me/stats` | Trips, markers, photos counts |
| GET | `/me/trips` | Owned + collaborating, cursor paginated; each item has `role`, `coverThumbUrl` (first cover photo in the trip, or null), `dayCount`, `markerCount` |
| PUT | `/me/devices/{fcmToken}` | Register/refresh push device. Body: `platform` (`android`\|`ios`), `locale` |
| DELETE | `/me/devices/{fcmToken}` | |
| POST | `/me/export` | Starts GDPR export job; email when ready |
| DELETE | `/me` | Starts account deletion (see `account-deletion` skill) |

### Users
| Method | Path | Notes |
|---|---|---|
| GET | `/users/check-username?username=` | `{ username (normalized), available, reason? (invalid\|taken) }`. Allowed during onboarding |
| GET | `/users/search?q=` | Prefix search on username and display name |
| GET | `/users/{username}` | Public profile + public trips |
| POST | `/users/{id}/block` | |
| DELETE | `/users/{id}/block` | |
| GET | `/me/blocks` | |

### Trips
| Method | Path | Notes |
|---|---|---|
| POST | `/trips` | Title, dates, visibility, optional initial `memberUsernames` |
| GET | `/trips/{id}` | Trip with days, markers (cover thumbnail URLs), members, `copiedFrom` summary |
| PATCH | `/trips/{id}` | Owner: title, dates, visibility |
| DELETE | `/trips/{id}` | Owner |
| POST | `/trips/{id}/copy` | "Add to my trips". Public, not own. Returns the new trip |
| GET | `/explore/trips` | Public trips from others, ranked |

### Days
| Method | Path | Notes |
|---|---|---|
| POST | `/trips/{id}/days` | Append a day |
| DELETE | `/days/{id}` | Deletes its markers |
| PUT | `/days/{id}/marker-order` | Body: ordered marker IDs |
| POST | `/days/{id}/optimize` | Best route. Free: straight-line. Premium: travel times. Returns proposed order + `mode` + optional `savedMinutes`; `?apply=true` persists |

### Members and invites
| Method | Path | Notes |
|---|---|---|
| POST | `/trips/{id}/members` | Owner adds by username |
| DELETE | `/trips/{id}/members/{userId}` | Owner removes, or editor removes self (leave) |
| POST | `/trips/{id}/invites` | Owner creates invite link → `{ url, expiresAt }` |
| DELETE | `/trips/{id}/invites/{inviteId}` | Revoke |
| GET | `/invites/{token}` | Preview (trip title, owner) |
| POST | `/invites/{token}/accept` | Join as editor |

### Markers
| Method | Path | Notes |
|---|---|---|
| POST | `/days/{id}/markers` | Either `placeId`, or `name` + `location` (+ optional `osmType`/`osmId` from a Photon result). Optional `time`. Google IDs not accepted |
| GET | `/markers/{id}` | Marker with photos, like state, comment count |
| PATCH | `/markers/{id}` | Name, time, location, move to another day of the same trip |
| DELETE | `/markers/{id}` | |
| POST | `/markers/{id}/copy` | Body: target `dayId` in one of my trips |

### Photos
| Method | Path | Notes |
|---|---|---|
| POST | `/markers/{id}/photos/upload-url` | Body: mime type, size. Returns photo ID + pre-signed PUT URL |
| POST | `/photos/{id}/complete` | Client confirms upload → processing job |
| GET | `/markers/{id}/photos` | Ordered gallery |
| PUT | `/markers/{id}/photo-order` | |
| PUT | `/markers/{id}/cover` | Body: `photoId` |
| DELETE | `/photos/{id}` | Uploader, trip owner or editor |

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
| GET | `/places/in-view?bbox=minLng,minLat,maxLng,maxLat&zoom=&categories=&limit=` | Places for the visible map area: Tripinly places first, OSM places when zoomed in, clusters when zoomed out |
| GET | `/places/search?q=&lat=&lng=` | Our places + Photon addresses/cities merged |
| GET | `/places/nearby?lat=&lng=&radiusKm=` | Popular places around the user; location not stored |
| GET | `/places/popular?bbox=…&excludeTripId=` | Tripinly places only in the visible area, excluding places already in the trip |
| GET | `/places/{id}` | Place with popularity and a few public photos |
| POST | `/places/{id}/add-to-trip` | Body: `dayId` → new marker |

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

- **Trip** (`GET /trips/{id}`): `id`, `title`, `startDate`, `endDate`, `visibility`, `owner` (user summary), `myRole` (`owner`\|`editor`\|`viewer`), `members[]`, `likeCount`, `likedByMe`, `copyCount`, `copiedFrom` (`{ tripId, owner: { username } }` or null), `days[]` → `{ id, position, date, markers[] }`.
- **Marker**: `id`, `dayId`, `placeId`, `name`, `location`, `time` (`HH:mm` or null), `position`, `coverPhotoId`, `coverThumbUrl`, `photoCount`, `likeCount`, `likedByMe`, `commentCount`, `createdBy` (user summary or null).
- **Photo**: `id`, `markerId`, `status` (`processing`\|`ready`\|`failed`), `thumbUrl`, `displayUrl` (signed, expire after ~1 h), `width`, `height`, `position`, `likeCount`, `likedByMe`, `uploader`.
- **User summary**: `id`, `username`, `displayName`.
- **Place** (in-view/search/along-the-way): see `10-maps-places-routing.md`.
- **Me**: profile fields, `onboarding` state, `defaultTripVisibility`, `locale`, `entitlements[]` (e.g. `best_route_realtime`).

## Stable error codes (starter set)

`UNAUTHENTICATED`, `TOKEN_EXPIRED`, `REFRESH_TOKEN_REUSED`, `ONBOARDING_INCOMPLETE`, `CONSENT_REQUIRED`, `AGE_REQUIREMENT_NOT_MET`, `USERNAME_TAKEN`, `USERNAME_INVALID`, `USERNAME_CHANGE_TOO_SOON` (422, `details.availableAt`), `VALIDATION_FAILED`, `NOT_FOUND`, `FORBIDDEN`, `TRIP_NOT_COPYABLE`, `USER_BLOCKED`, `INVITE_EXPIRED`, `PHOTO_LIMIT_REACHED`, `UPLOAD_TOO_LARGE`, `UNSUPPORTED_MEDIA_TYPE`, `PREMIUM_REQUIRED`, `RATE_LIMITED` (429, `details.retryAfterSeconds`, `Retry-After` header), `ACCOUNT_SUSPENDED`, `REAUTH_REQUIRED`, `ROUTING_UNAVAILABLE`, `BBOX_TOO_LARGE`, `SERVICE_UNAVAILABLE` (503, e.g. `/health/ready` when a dependency is down), `INTERNAL_ERROR` (500, never carries internal details).

Add new codes here when you introduce them.
