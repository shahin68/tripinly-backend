# Tripinly — Real Time and Notifications

## Real time (Socket.IO)

- Namespace `/v1/realtime` (Socket.IO default path `/socket.io`, WebSocket transport). Clients connect with the access token in the handshake `auth.token`. A refused handshake arrives as `connect_error` with `data.code`: `UNAUTHENTICATED`, `TOKEN_EXPIRED`, `ACCOUNT_SUSPENDED`, `ONBOARDING_INCOMPLETE` or `CONSENT_REQUIRED` (the same gate as REST). When the token expires on an open socket, the server emits `error { code: "TOKEN_EXPIRED" }` and disconnects; the client refreshes, reconnects and refetches.
- Redis adapter so several API instances share rooms. The worker publishes through the same Redis (`@socket.io/redis-emitter`), so events raised there (photo processing, notifications) reach sockets too.
- Rooms:
  - `user:{userId}` — joined automatically on connect. Personal notifications, trip list changes.
  - `trip:{tripId}` — joined via `trip.subscribe { tripId }`. The server runs the `TripAccessService` read check before joining; leave with `trip.unsubscribe { tripId }`. Both answer through the Socket.IO acknowledgement: `{ ok: true, tripId }` or `{ ok: false, tripId, error: { code } }` (`NOT_FOUND` without access, `VALIDATION_FAILED` for a bad id); a refusal is also emitted as `error { code, tripId }`.
- Sockets that lose `view` are removed from the room: non-members when the trip turns private, a removed member of a private trip (or after a block), each side of a new block from the other's trips. `trip.deleted` is sent, then the room is emptied.
- Events are **notifications of change with enough data to update the UI**, not a replacement for REST. On reconnect, clients refetch the trip.
- Every event payload: `{ "event": "...", "tripId": "...", "actorId": "...", "at": "ISO", "data": { ... } }`.
- The actor's own socket also receives events (clients de-duplicate by entity ID).
- Blocked users are never delivered events caused by the user they blocked (or who blocked them).
- Payloads are the REST DTOs, made viewer-neutral: `likedByMe` (`hotByMe` on markers) is always `false` in marker, photo and comment payloads (and `canDelete` false on comments); keep the local value.

### Event catalogue (trip room)

| Event | When | Data |
|---|---|---|
| `trip.updated` | Title, dates, destination, visibility changed | changed fields |
| `trip.deleted` | Trip deleted | — (clients leave the room) |
| `day.created` / `day.deleted` | | day |
| `marker.created` / `marker.updated` / `marker.deleted` | | marker (its cover only when picked: the place's image depends on the viewer, so apps keep the one they have, or load the stop) |
| `markers.reordered` | Order change or best route applied | dayId, ordered IDs |
| `photo.processing` | Upload confirmed | photo stub |
| `photo.ready` / `photo.failed` | Thumbnail job finished | photo with URLs |
| `photo.deleted` | | photoId, markerId, the stop's picked cover photo after it (null when the deleted photo was the cover) |
| `marker.cover_changed` | Cover picked (a photo or Commons image id) | markerId, photoId |
| `comment.created` / `comment.deleted` | | comment (viewer-neutral: `likedByMe` false, `canDelete` false) / commentId, markerId |
| `place.hot_changed` | A place marked or unmarked hot, in the room of every trip with a visible stop there (the stops show the place's count) | placeId, hotCount (at once, every change) |
| `like.count_changed` | Any like on trip/photo/comment, in its trip's room | targetType, targetId, count (at once, every like and unlike; Shahin 2026-11-01, was throttled to one per 2 s) |
| `member.added` / `member.removed` | | `{ member: { user, role } }` / `{ userId, reason: left\|removed\|blocked }` |

Domain events that don't go to a room as such: `join_request.created` (actor = the person asking; data: requestId, ownerId) for the owner's `join_requested` notification, `user.followed` (actor = the follower; data: followeeId; only for a new follow, not a repeat) for a future notification. `place.hot_changed` goes to the trips with stops at the place.

### User room

| Event | Data |
|---|---|
| `notification.created` | notification (as in `GET /notifications`, in the user's saved language). Every push is its own entry now; entries from groups opened before 2026-11-01 may still come again with the same `id` and a higher `count`: replace by id |
| `trips.changed` | `{ tripId, change: added\|removed }` — trip created (owner and members), added as member, removed/left, trip deleted |
| `follows.changed` | `{ followerId, followeeId, following }` — someone followed or unfollowed; sent to both people, so profile counts and Friends/Following/Followers lists can reload |
| `photo.ready` / `photo.failed` | Place photos only (they have no trip room): sent to their uploader, same data as in the trip room (`placeId` set, `markerId` null) |
| `account.suspended` | `{}` — an admin suspended the account; the server disconnects every socket of the user right after, and HTTP calls answer 403 `ACCOUNT_SUSPENDED`. Account deletion disconnects the same way, without an event |

## Push notifications (FCM)

Triggered from domain events by the notifications module, executed as BullMQ jobs.

| Type | Recipient | Push (en) | Tap opens | Switch |
|---|---|---|---|---|
| `comment_on_marker` | Trip owner and the marker's creator (if different), not the commenter | Anna commented on DC Flats / *the comment* | The stop (`markers/{id}`) | Comments |
| `added_to_trip` | The person the owner added | Anna added you to Vienna / Open it to plan together. | The trip | Added to trips |
| `join_accepted` | The person whose join request the owner accepted | Anna accepted your request / You're in Vienna now. | The trip | Added to trips |
| `join_requested` | Trip owner, once per request | Anna wants to join Vienna / Tap to accept or decline. | The trip's Members sheet (`trips/{id}/members`) | Join requests |
| `trip_changed_by_collaborator` | Trip owner and editors except the actor | Changes in Vienna / Anna added a place | The stop when it is about one (added, edited, photo added), else the trip | Collaborator changes |
| `likes_grouped` | Owner of the liked item | Anna liked your trip / Vienna; Anna liked your photo / DC Flats · Vienna; Anna liked your comment / "you coming?" on DC Flats | The photo's or comment's stop; the trip for a trip like | Likes |
| `trip_saved` | Trip owner | Anna saved your trip / Vienna | The trip | Likes |
| `place_hot` | Only the creator of a spot someone made (OSM spots have none), when its hot count reaches 5, 25, 100, 500, 1000 or 5000, once per milestone | DC Flats is getting hot / 25 people marked your spot hot. Nice find! | The creator's newest stop at that spot, else the app | Likes |
| `followed` | The person followed, at most once a day per follower | Anna followed you / Follow back to become friends. | Anna's profile (`users/{username}`) | New followers |
| `became_friends` | The person followed back (instead of `followed`), at most once a day | You and Anna are now friends / You can add each other to trips. | Anna's profile | New followers |

Silent on purpose: unfollows, a declined join request, being removed from a trip, and single flames (Shahin, 2026-11-01: pushes cost money, so a flame never pushes by itself; a famous spot can sit in hundreds of trips).

- The API turns domain events into `plan` jobs on the `notifications` queue; the worker picks recipients, writes rows and sends. Recipients never include the actor, anyone with a block either way with the actor, inactive accounts, or anyone who can't view the trip.
- **Every notification pushes at once** (Shahin, 2026-11-01; replaces the 10-minute batch and the hourly likes summary). The same notification again (same recipient, same person, same kind, same item: a like, unlike and like again; the same stop moved twice) within `NOTIFICATION_REPEAT_COOLDOWN_SECONDS` (worker, default 5) is dropped, row and push.
- Collaborator changes are: trip updated, day added/deleted, marker added/updated/deleted, markers reordered, photo uploaded.
- Own likes never notify. Hot marks only count toward `place_hot` milestones. Likes on a trip go to its owner, on a photo to its uploader, on a comment to its author. Stops have no likes of their own (their place does).
- At send time the recipient's access is checked again: someone who lost access to the trip gets no push and the entry is deleted. The in-app list also hides entries about trips the user can no longer see, and entries caused by someone they have a block with. Deleting a comment deletes its notifications.
- Respect `notification-settings`: each switch turns off its whole group (column Switch above; `SETTING_FOR_TYPE`). The in-app notification is still created when the push is off, so pin marks still show.
- **New-activity marks:** `GET /v1/trips/{id}/new-activity` returns the stops of the trip with unread notifications for me (same visibility as the list: no blocked actors). The app shows them as "new" dots on pins and day tabs; opening a stop sends `POST /v1/notifications/read` with `{ markerId }`, which clears it. A `notification.created` with a `markerId` adds a mark live.
- Localize using the recipient's device `locale` (fallback user locale, then `en`). Templates live in the i18n files, keyed `push.<type>.title` / `.body` with ICU plural support.
- Payload: a `notification` (title, body) plus `data: { type, notificationId, deepLink }`. Deep links: `tripinly://markers/{id}` (anything about one stop; older apps open its trip), `tripinly://trips/{id}/members` (join requests), `tripinly://users/{username}` (follows), `tripinly://trips/{id}` (everything else about one trip), `tripinly://notifications` (nothing to open, e.g. an old grouped summary or a hot spot with no stop of the creator's).
- Pushes are skipped while `FIREBASE_SERVICE_ACCOUNT_JSON` is unset; in-app notifications and realtime still work.
- Remove device tokens that FCM reports as unregistered.
- Never include private trip content in a push to someone who isn't a member.

## Email

Transactional only, via Resend, localized templates:

| Email | When |
|---|---|
| `data_export_ready` | Export job finished; contains a signed download link valid 7 days |
| `account_deletion_confirmed` | Deletion finished (sent to the provider email captured before deletion, then the address is discarded) |

No marketing email in v1.

- Queued with `EmailService.send(template, to, locale, params)` on the `email` queue; the worker renders (`i18n/<lang>/email.json`, HTML plus a text part) and sends through Resend with the job id as idempotency key. Five attempts with backoff.
- The address exists only in the job, which is removed when it finishes or fails; logs name the template, never the address.
- Skipped with a warning while `RESEND_API_KEY` is unset. `EMAIL_FROM` must be an address on a domain verified in Resend.
