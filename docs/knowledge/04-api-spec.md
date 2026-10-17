# Tripinly — API Spec

REST over HTTPS, JSON, base path `/v1`. The OpenAPI document generated from the code (`/v1/openapi.json`) is what the KMP client consumes. Swagger UI is served at `/v1/docs` on local and staging (not on production, decided by `DEPLOY_ENV`). This file describes intent and conventions.

## Conventions

- **Auth:** `Authorization: Bearer <accessToken>` on everything except `/auth/*`, `/legal/*`, `/health`, `/app-config` and public share previews.
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
- **Idempotency:** likes and unlikes are idempotent. `POST` creating content (trips, days, markers, add-to-trip, marker copy, comments, invites) accepts an optional `Idempotency-Key` header: a client-generated UUID, new per user action and reused on its retries. For 24 hours a retry with the same key and the same request returns the first response with the header `Idempotent-Replayed: true` and creates nothing. The same key with a different request → 422 `IDEMPOTENCY_KEY_REUSED`; while the first request is still running → 409 `IDEMPOTENCY_KEY_IN_PROGRESS`; a malformed key (not 1–255 visible ASCII characters) → 400 `VALIDATION_FAILED`. Failed requests don't keep the key, so a retry runs again. Keys are per user. `upload-url` is left out because its response holds a signed URL; `POST /reports` already answers a repeat with the existing report.
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
| GET | `/me/trips` | Owned + collaborating + saved (saved ones only while public and visible to me; `savedByMe = true`, `role` `viewer`), most recently changed first (marker and day edits count), cursor paginated; each item has `role`, `coverThumbUrl` (first cover photo in the trip, or null), `dayCount`, `markerCount`, `editorCount` (people it's shared with, owner not counted) |
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
| GET | `/users/{username}?cursor=&limit=` | Public profile: `{ user, followerCount, followingCount, isFollowing (I follow them), followsMe, isFriend (both), publicTripCount, trips[] (trip summaries, most recently changed first), nextCursor }`. The counts leave out suspended or deleting users and anyone with a block with me. On my own profile the three flags are `false`. Unknown, or a block either way → 404 |
| PUT | `/users/{id}/follow` | Follow → 204, no approval, idempotent. Myself → 400 `VALIDATION_FAILED` (`fields.id = ["cannotFollowSelf"]`); unknown, not onboarded, suspended or deleting, or a block either way → 404. Emits `user.followed` (no push yet) |
| DELETE | `/users/{id}/follow` | Unfollow → 204, idempotent (also when not following). Myself → 400 like above |
| GET | `/me/friends?cursor=&limit=` | People I follow who follow me back, by `displayName` then `id`: `{ items: [user summary], nextCursor }`. Suspended users and anyone with a block either way are left out. The trip member picker lists these |
| GET | `/me/following?cursor=&limit=` | People I follow, most recently followed first; same shape and filters |
| GET | `/me/followers?cursor=&limit=` | People who follow me, most recent first; same shape and filters |
| POST | `/users/{id}/block` | 204, idempotent. Also removes follows both ways, each user from the other's trips as an editor, and each side's saves of and join requests to the other's trips |
| DELETE | `/users/{id}/block` | 204, idempotent |
| GET | `/me/blocks` | Users I blocked, cursor paginated |

### Trips
| Method | Path | Notes |
|---|---|---|
| POST | `/trips` | `title`, optional `startDate`/`endDate` (one day per date, max 20; `endDate` needs `startDate`; no dates → one "Day 1"), optional `destination` `{ name (1–200), location { lat, lng } }` (e.g. a city from `/places/search`), `visibility` (default: my `defaultTripVisibility`), `memberUsernames` (≤ 200 per request, added as editors; unknown → 400 `fields["memberUsernames.<i>"] = ["notFound"]`, ones I blocked → `["blocked"]`). Max 200 owned trips |
| GET | `/trips/{id}` | Trip with days, markers (cover thumbnail URLs), members, my save and join-request state |
| PATCH | `/trips/{id}` | Owner: `title`, `visibility`, `destination` (null removes it), `startDate` (null removes both dates, days stay), `endDate` (resizes: adds empty days, removes trailing days only if empty, else 400 `fields.endDate = ["daysNotEmpty"]`) |
| DELETE | `/trips/{id}` | Owner |
| PUT | `/trips/{id}/save` | "Add to my trips" as a read-only save of someone else's public trip → 204, idempotent. Own or member trip → 403 `FORBIDDEN`; private trip I'm not in, or a block either way → 404. Trips are never copied (`POST /trips/{id}/copy` removed 2026-10-16) |
| DELETE | `/trips/{id}/save` | Unsave → 204, idempotent |
| POST | `/trips/{id}/join-request` | Ask the owner to join as an editor → 200 join request `{ id, tripId, user, status: pending, createdAt }`; repeating a pending request returns it, with no new notification. The owner gets `join_requested`. Declined before → 409 `JOIN_REQUEST_DECLINED`. Own or member trip → 403 `FORBIDDEN`; private trip I'm not in, or a block → 404 |
| DELETE | `/trips/{id}/join-request` | Withdraw my pending request → 204, idempotent; a declined one stays declined |
| GET | `/trips/{id}/join-requests?cursor=&limit=` | Owner: pending requests, newest first → `{ items: [join request], nextCursor }` (people who are suspended, deleting or with a block with me left out). Others → 403 (404 if they can't see the trip) |
| POST | `/join-requests/{id}/accept` | Owner: the person becomes an editor → 200 member `{ user, role }`; the request (and their save of the trip) is removed; `member.added` and an `added_to_trip` push follow. Over `APP_TRIP_MAX_MEMBERS` → 422 `LIMIT_REACHED`. Not the owner, already decided, or the person is gone or blocked → 404 |
| POST | `/join-requests/{id}/decline` | Owner → 204; the person's `myJoinRequest` becomes `declined` and they can't ask again. Not the owner or already decided → 404 |
| GET | `/explore/trips?cursor=&limit=&includeMine=&period=&lat=&lng=` | Public trips with at least one marker, mine included (`role` says owner or editor; no Save on those) unless `includeMine=false` (default `true`) leaves out trips I own or edit, ranked by likes only (saves never count), newest on ties. `period`: `all` (default, all likes), `week`/`month`/`year` (likes of the last 7/30/365 days), `season` (trips whose start or end date falls in the current season: Dec–Feb, Mar–May, Jun–Aug, Sep–Nov; all likes). `lat`+`lng` (both or neither) keep trips with a stop within `APP_EXPLORE_NEARBY_RADIUS_KM` (default 50), combinable with any period; the point is used for the query only, never stored or logged. Trip summaries; `nextCursor` (sent with the same filters) continues the same ranking |

### Days
| Method | Path | Notes |
|---|---|---|
| POST | `/trips/{id}/days` | Append a day (owner or editor); extends `endDate` for dated trips. Max 20 |
| DELETE | `/days/{id}?confirm=` | Deletes its markers; later days move up and `endDate` shrinks. The last day can't be deleted (400 `fields.id = ["lastDay"]`). Same rules as deleting each stop: the trip owner, or an editor when every stop on it is theirs (else 403 `FORBIDDEN`); other people's photos, comments or likes on them → 409 `STOP_HAS_OTHERS_CONTENT` unless `confirm=true` |
| PUT | `/days/{id}/marker-order` | Body: `markerIds`, exactly the day's markers in the new order (else 400 `fields.markerIds = ["mustMatchDayMarkers"]`). Returns `{ dayId, markerIds }` |
| POST | `/days/{id}/optimize?mode=&apply=` | Best route, first marker fixed → 200 `{ dayId, markerIds, mode (straight_line\|travel_time), savedMinutes (travel_time only, else null), degraded, applied }`. Free: straight-line distance. With `best_route_realtime`: openrouteservice travel times for `mode` (default walking); if they're unavailable, straight line with `degraded: true`. Anyone who can see the trip gets a proposal; `apply=true` (owner or editor) saves it and emits `markers.reordered`. Up to 25 markers (422 `LIMIT_REACHED`, `resource: optimizeMarkers`) |

### Members and invites
| Method | Path | Notes |
|---|---|---|
| POST | `/trips/{id}/members` | Owner adds by `username` → member `{ user, role }`; idempotent. Someone I blocked → 403 `USER_BLOCKED`; someone who blocked me or unknown → 404. At most `APP_TRIP_MAX_MEMBERS` people (default 50, owner included), else 422 `LIMIT_REACHED` |
| POST | `/trips/{id}/members/batch` | Owner adds several editors at once (e.g. friends picked in a row): `{ usernames: [1..200] }` → 200 `{ items: [{ user, role }] }`, the requested people in request order (the owner's own username is skipped). All or nothing: unknown or blocked-me → 400 `fields["usernames.<i>"] = ["notFound"]`, people I blocked → `["blocked"]`. People already in the trip stay as they are and get no new notification. Over `APP_TRIP_MAX_MEMBERS` → 422 `LIMIT_REACHED`. Each newly added person gets the usual `member.added` event and push |
| DELETE | `/trips/{id}/members/{userId}` | Owner removes, or editor removes self (leave). The owner can't be removed (403) |
| POST | `/trips/{id}/invites` | Owner creates invite link → `{ id, url, token, expiresAt, createdAt }` (the token is shown only here). Valid 7 days, reusable, max 20 active |
| GET | `/trips/{id}/invites` | Owner lists active invites (`id`, `expiresAt`, `createdAt`) so they can be revoked |
| DELETE | `/trips/{id}/invites/{inviteId}` | Revoke; idempotent |
| GET | `/invites/{token}` | Preview: `tripId`, `title`, `owner`, dates, `expiresAt`, `alreadyMember`. 410 `INVITE_EXPIRED` when expired or revoked; 404 if unknown or the owner and I have a block |
| POST | `/invites/{token}/accept` | Join as editor → the trip. Idempotent for members |

### Markers
| Method | Path | Notes |
|---|---|---|
| POST | `/days/{id}/markers` | Optional client-chosen `id` (UUID) so the app can show and edit the marker before the response; a taken ID → 409 `ID_CONFLICT` (a client that gets this for its own retried create treats the marker as saved). Either `placeId` (optional `name` overrides the place name), or `name` + `location` (+ optional `osmType`/`osmId` from a Photon result, `category` for a new place), or `location` alone for a tap on the map: the server names the stop after one of our public places within 25 m (and links it), else the Photon reverse address there (with its OSM ids), else the coordinates (`48.20383, 16.36958`). The point is used for the lookup only. Optional `time` (`HH:mm`), `position` (insert; appended when omitted). Unknown fields such as a Google place ID → 400. Max 50 per day |
| DELETE | `/days/{id}/markers?confirm=` | Clears the day: deletes all its markers in one request → 204, also when already empty; the day stays. Moderated (hidden) markers stay. All or nothing: the trip owner, or an editor when every stop on it is theirs (else 403 `FORBIDDEN`); other people's content → 409 `STOP_HAS_OTHERS_CONTENT` unless `confirm=true`. Emits `marker.deleted` per marker |
| GET | `/markers/{id}` | Marker with photos, like state, comment count |
| PATCH | `/markers/{id}` | `name`, `time` (null clears), `placeId` or `location` (re-matches the place), `dayId` (another day of the same trip, else 400 `fields.dayId = ["notInTrip"]`), `position` |
| DELETE | `/markers/{id}?confirm=` | Deletes the stop with everything on it. Only whoever added it, or the trip owner (other editors → 403 `FORBIDDEN`; they use `/mine`). When other people's photos, comments or likes on those are on it → 409 `STOP_HAS_OTHERS_CONTENT` with `details { photos, comments, likes }` (counts; likes on the place don't count, they stay) unless `confirm=true`: the app warns, then repeats with `confirm=true`. A user-made place goes with its last stop anywhere, with its place photos |
| DELETE | `/markers/{id}/mine` | Removes my photos, comments and my likes on its photos and comments from the stop (my like on its place stays); the stop and everyone else's content stay. Anyone who can see the stop → 204, also when there was nothing of mine. A cover among my photos passes to the next ready photo |
| POST | `/markers/{id}/copy` | Body: `dayId` (a day of a trip I own or edit), optional `position` → 201 with the new marker (same name, location, time, place; no photos, comments or likes). Marker of my own or a private trip → 403 `TRIP_NOT_COPYABLE` |

### Photos
| Method | Path | Notes |
|---|---|---|
| POST | `/markers/{id}/photos/upload-url` | Body: `mimeType` (`image/jpeg`\|`image/png`\|`image/webp`, else 415 `UNSUPPORTED_MEDIA_TYPE`), `bytes` (≤ 15 MB, else 413 `UPLOAD_TOO_LARGE`). Editors and owner; 30 photos per marker (422 `PHOTO_LIMIT_REACHED`); 60/min per user. Returns `{ photo, uploadUrl, uploadHeaders, expiresAt }`: PUT the file to `uploadUrl` within 10 minutes with exactly `uploadHeaders` (`Content-Type`, `Content-Length`). 503 `SERVICE_UNAVAILABLE` while storage isn't configured |
| POST | `/photos/{id}/complete` | The uploader confirms → 202 with the photo (`processing`); `photo.ready` follows. Not uploaded yet or a different size → 400 (`upload: notUploaded \| sizeMismatch`). Repeating it returns the photo as is |
| POST | `/places/{id}/photos/upload-url` | A **place photo**: on the place, not on a trip (an OSM place, or a user place I can see; else 404). Same body, file rules, response and `POST /photos/{id}/complete` as marker photos. At most `APP_PLACE_PHOTO_DAILY_LIMIT` (default 20) place photos per person in 24 hours → 422 `DAILY_PHOTO_LIMIT_REACHED` (`details.max`). `photo.ready` / `photo.failed` come in my own user room (no trip). It stays until I delete it or my account goes, or with the user place's last stop |
| GET | `/places/{id}/photos` | The place's ready photos, most liked first, then newest (≤ 100, not paginated); my own processing and failed ones too. A photo by someone with a block either way shows with `uploader: null` (place photos stay visible across blocks; liking them doesn't) |
| GET | `/markers/{id}/photos` | Gallery in order (not paginated; ≤ 30). Viewers get ready photos; members also processing and failed ones |
| PUT | `/markers/{id}/photo-order` | Body: `photoIds`, exactly the marker's processing and ready photos (400 `photoIds: mustMatchMarkerPhotos`). Returns the gallery |
| PUT | `/markers/{id}/cover` | Body: `photoId` (a ready photo of this marker, else 400 `photoId: notFound \| notReady`). Returns the marker. The first ready photo becomes the cover automatically |
| DELETE | `/photos/{id}` | Trip photos: uploader (even after leaving the trip), trip owner or editor; a deleted cover passes to the next ready photo. Place photos: only the uploader (403 otherwise) |

### Comments and likes
| Method | Path | Notes |
|---|---|---|
| GET | `/markers/{id}/comments?cursor=&limit=` | Oldest first. Comments from people with a block with me are left out |
| POST | `/markers/{id}/comments` | Body: `body` (trimmed, 1–1000 chars) → 201 comment. Members, or anyone for a public trip; not on a marker created by someone I have a block with (403). 30/min per user |
| DELETE | `/comments/{id}` | 204. The author (even after leaving the trip) or the trip owner; others 403 |
| PUT | `/likes/{targetType}/{targetId}` | `trip`, `photo` (ready only), `comment`, `place` → `{ targetType, targetId, liked, likeCount }` (a place's `likeCount` is its popularity). A stop's like button likes its place (`place`, the marker's `placeId`); `marker` → 400. Idempotent. Not visible, hidden, across a block, or a custom spot only in private trips (`canLike: false`) → 404 |
| DELETE | `/likes/{targetType}/{targetId}` | Same response with `liked: false`. Idempotent |

### Discovery
| Method | Path | Notes |
|---|---|---|
| GET | `/places/in-view?bbox=minLng,minLat,maxLng,maxLat&zoom=&categories=&limit=` | Places for the visible map area: `{ places[], clusters[], attribution }`. Tripinly places first, OSM places from zoom 14 (from zoom 10 only notable ones, with a Wikidata entry, while Tripinly places are fewer than `limit`), clusters below zoom 14 when there are more than `limit` (10–200, default 100). Picks don't change while the view pans within the same area. A bbox too large for the zoom → 400 `BBOX_TOO_LARGE` |
| GET | `/places/tiles?tiles=z/x/y,…&zoom=&categories=&limit=` | The same places as in-view for up to 16 map squares in one request: `{ tiles: [{ tile, places[], clusters[] }], attribution }`. Square `z/x/y` covers longitudes `x·s … (x+1)·s` and latitudes `y·s … (y+1)·s` with `s = 360 / 2^z` degrees (x, y may be negative). Each square answers exactly like in-view for its bbox. Malformed squares or more than 16 → 400 `VALIDATION_ERROR` (`matches`), squares off the map → `invalidTiles`; a square too large for the zoom → 400 `BBOX_TOO_LARGE` |
| GET | `/places/search?q=&lat=&lng=&scope=` | `{ items[], attribution }`: our places (`source: "place"`, with `id`) then Photon results (`source: "photon"`, no `id`; send name + location + `osmType`/`osmId` when adding the marker). `q` 1–100 chars (one letter searches Photon only); 60 requests/min per user. `scope=destination` (default `all`) returns only countries, regions, cities and districts from Photon, cities before districts, for a trip destination |
| GET | `/places/nearby?lat=&lng=&radiusKm=&cursor=&limit=` | Popular places around the user (radius 0.1–50 km, default 5), each with `distanceMeters`; the first page is topped up with OSM sights when fewer than 10 are in range. Location not stored |
| GET | `/places/popular?bbox=…&excludeTripId=&limit=` | Tripinly places only in the visible area (bbox side ≤ 5°), excluding places already in the trip |
| GET | `/places/{id}` | Place detail: the Place fields plus source, OSM ids, tags (website, openingHours, cuisine, wikidata), `images` (up to 10 public trip photos that may represent the place, see the Place shape, most outside likes first, then its Wikimedia Commons images; each `{ id, source: trip\|commons, thumbUrl, displayUrl, width, height, credit }`, where `credit` is `{ author, title, license, licenseUrl, sourceUrl }` for Commons and null for trip photos), `photoThumbUrls` (deprecated: the trip photos' thumbs only; removed after the apps move to `images`), `attribution` |
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
| GET/PATCH | `/me/notification-settings` | `{ commentOnMarker, addedToTrip, tripChangedByCollaborator, likesGrouped, joinRequested }`, all `true` by default; PATCH sends only what changes. Off stops the push, not the in-app entry |

Real time: Socket.IO namespace `/v1/realtime`, see `05-realtime-and-notifications.md`.

### Moderation
| Method | Path | Notes |
|---|---|---|
| POST | `/reports` | Body: `targetType` (`user`\|`trip`\|`marker`\|`photo`\|`comment`\|`place_image`), `targetId`, `reason` (`spam`\|`harassment`\|`nudity`\|`violence`\|`hate`\|`copyright`\|`other`), optional `details` (≤ 1000) → 201 **Report** `{ id, targetType, targetId, reason, status, createdAt }`. An open report by the same user on the same target answers 200 with it. The target must be visible to the caller (404 otherwise); a user can be reported even across a block. 20 per day (429 `RATE_LIMITED`) |
| GET | `/admin/reports?status=&cursor=&limit=` | Admin only (403 `FORBIDDEN` otherwise). `status` defaults to `open`; oldest first. Item: the report plus `details`, `action`, `reviewedAt`, `reporter` (`{ id, username }` or null), `openReportCount` (open reports on the same target), `target` `{ exists, owner { id, username } \| null, text (title, name, comment body or display name), thumbUrl (photos), tripId, hidden }` |
| PATCH | `/admin/reports/{id}` | Admin only. Body `{ action: dismiss\|hide_content\|suspend_user\|delete_content, note? }` → the updated report. Resolves every open report on the same target and writes the audit log. `hide_content` / `delete_content` need a content target (400 `VALIDATION_FAILED` for a user; a `place_image` can only be hidden, so `delete_content` and `suspend_user` answer 400 for it); `suspend_user` suspends the reported user or the content's author (403 for an admin) |

### Ops
| Method | Path | Notes |
|---|---|---|
| GET | `/app-config` | Settings for the apps (no auth): `{ placesRefreshSeconds, photoMaxEdgePx, photoJpegQuality, photoParallelUploads, pinLargeMinProminence, pinMediumMinProminence, mapMaxPins }`. See "App settings" below |
| GET | `/health` | Liveness (no auth). Full path `/v1/health` |
| GET | `/health/ready` | DB + Redis reachable and every migration this build ships with applied (none failed); `checks: { database, redis, migrations }`, 503 `SERVICE_UNAVAILABLE` with `details.checks` otherwise. Full path `/v1/health/ready` |
| GET | `/.well-known/assetlinks.json`, `/.well-known/apple-app-site-association` | Android App Links / iOS Universal Links for invite and share URLs (served on the app-link domain) |

## Key response shapes

Field names the client relies on (full schemas in OpenAPI):

- **Trip** (`GET /trips/{id}`): `id`, `title`, `startDate`, `endDate`, `destination` (`{ name, location }` or null; the client opens the map there while the trip has no markers), `visibility`, `owner` (user summary), `myRole` (`owner`\|`editor`\|`viewer`), `members[]` → `{ user, role }` (owner first; people with a block with me are left out), `likeCount`, `likedByMe`, `saveCount`, `savedByMe`, `myJoinRequest` (`pending`\|`declined`\|null), `pendingJoinRequestCount` (owner only, else 0), `days[]` → `{ id, position, date (startDate + position, or null), markers[] }`, `createdAt`, `updatedAt`.
- **Marker**: `id`, `tripId`, `dayId`, `placeId`, `name`, `location`, `time` (`HH:mm` or null), `position`, `coverPhotoId`, `coverThumbUrl`, `photoCount`, `likeCount` and `likedByMe` (its **place's** likes, the same on every stop at that place), `canLike` (false for a custom spot that is only in private trips: no like button), `commentCount`, `createdBy` (user summary, or null after account deletion or across a block), `createdAt`, `updatedAt`.
- **Photo**: `id`, `markerId`, `status` (`pending_upload`\|`processing`\|`ready`\|`failed`), `thumbUrl`, `displayUrl` (null until ready; signed, valid at least 1 h and unchanged within the hour so images cache), `width`, `height`, `position`, `likeCount`, `likedByMe`, `uploader` (null across a block), `createdAt`.
- **Trip summary** (My Trips, Explore, profiles): `id`, `title`, `startDate`, `endDate`, `visibility`, `owner`, `role` (`owner`\|`editor`\|`viewer`), `coverThumbUrl`, `dayCount`, `markerCount`, `likeCount`, `likedByMe`, `saveCount`, `savedByMe`, `updatedAt`.
- **Comment**: `id`, `markerId`, `body`, `author` (user summary), `likeCount`, `likedByMe`, `canDelete` (I wrote it or own the trip), `createdAt`.
- **User summary**: `id`, `username`, `displayName`.
- **Place** (in-view, popular, nearby, along-the-way): `id`, `name` (localized from OSM `name:<lang>` by `Accept-Language`), `category`, `location`, `isTripinly`, `likeCount`, `prominence` (0–100, how well known the place is, from QRank and OSM tags; 0 when unknown; the app sizes map pins by it), `coverThumbUrl` (or null): the public trip photo there with the most likes from people **outside its trip**, shown only when at least `APP_PLACE_PHOTO_MIN_OUTSIDE_LIKES` (2) such people liked it (likes by the uploader, the trip owner or the trip's members don't count; leaves out hidden content, suspended owners and blocks either way), else the place's first Wikimedia Commons image. `coverSource` (`trip` \| `commons` \| null) says which; `coverImageId` is the image's id either way (cache by it with the source); `coverPhotoId` is set only for a trip photo. A Commons cover needs the credit from `GET /places/{id}` when tapped. `likedByMe`. Nearby adds `distanceMeters`. Search results: `source`, `id` (null for Photon), `name`, `category` (null for Photon), `location`, `isTripinly`, `likeCount`, `type` and `address` (Photon), `osmType`, `osmId`. Every places response carries `attribution: "© OpenStreetMap contributors"`.
- **Me**: profile fields, `onboarding` state, `defaultTripVisibility`, `locale`, `entitlements[]` (e.g. `best_route_realtime`).


## App settings — `GET /app-config`

Values that steer how the apps behave (cache times, refresh intervals, limits) come from the server, so they can change without an app update (Shahin, 2026-10-10). Each one is an environment variable on the api (`APP_*`), so changing it on Railway takes effect after the api restarts. The app reads `/app-config` once per launch, before sign-in, and keeps a built-in default for each value, used until the answer arrives or when the call fails. A new tuning value for the apps goes here, not into app code. Feature flags will follow the same route after v1.

| Field | Meaning | Default |
|---|---|---|
| `placesRefreshSeconds` | How old a map square's places may get before the app reloads them in the background; older squares are still shown meanwhile | 300 |
| `photoMaxEdgePx` | Longest edge, in pixels, the app shrinks a photo to before uploading (1024–4096) | 2560 |
| `photoJpegQuality` | JPEG quality the app encodes photos with before uploading (50–100) | 85 |
| `photoParallelUploads` | Photos the app uploads at the same time (1–4) | 2 |
| `pinLargeMinProminence` | A place's `prominence` from which its map pin is drawn largest (0–100) | 95 |
| `pinMediumMinProminence` | A place's `prominence` from which its map pin is drawn middle-sized; below it, smallest (0–100) | 60 |
| `mapMaxPins` | Most place pins the app draws on the map at once (map markers keep their screen size, so each costs the app): liked places first, then the best known (20–1000) | 150 |

## Stable error codes (starter set)

`UNAUTHENTICATED`, `TOKEN_EXPIRED`, `REFRESH_TOKEN_REUSED`, `ONBOARDING_INCOMPLETE`, `CONSENT_REQUIRED`, `AGE_REQUIREMENT_NOT_MET`, `USERNAME_TAKEN`, `USERNAME_INVALID`, `USERNAME_CHANGE_TOO_SOON` (422, `details.availableAt`), `VALIDATION_FAILED`, `NOT_FOUND`, `FORBIDDEN`, `TRIP_NOT_COPYABLE` (copying a marker of my own or a private trip), `JOIN_REQUEST_DECLINED` (409), `USER_BLOCKED`, `INVITE_EXPIRED` (410), `PHOTO_LIMIT_REACHED`, `DAILY_PHOTO_LIMIT_REACHED` (422, `details.max`), `STOP_HAS_OTHERS_CONTENT` (409, `details.photos`, `details.comments`, `details.likes`; repeat with `confirm=true`), `LIMIT_REACHED` (422, `details.resource` = `trips`\|`days`\|`markers`\|`members`\|`invites`\|`optimizeMarkers`, `details.max`), `UPLOAD_TOO_LARGE`, `UNSUPPORTED_MEDIA_TYPE`, `PREMIUM_REQUIRED`, `RATE_LIMITED` (429, `details.retryAfterSeconds`, `Retry-After` header), `ACCOUNT_SUSPENDED` (403: suspended; also on refresh), `REAUTH_REQUIRED` (403: `DELETE /me` without a sign-in in the last 10 minutes), `ROUTING_UNAVAILABLE`, `BBOX_TOO_LARGE` (400, `details.maxSpanDegrees`), `IDEMPOTENCY_KEY_REUSED` (422), `IDEMPOTENCY_KEY_IN_PROGRESS` (409), `ID_CONFLICT` (409: a client-chosen `id` on create already exists), `SERVICE_UNAVAILABLE` (503, e.g. `/health/ready` when a dependency is down), `INTERNAL_ERROR` (500, never carries internal details).

Add new codes here when you introduce them.
