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
- Payloads are the REST DTOs, made viewer-neutral: `likedByMe` is always `false` in marker, photo and comment payloads (and `canDelete` false on comments); keep the local value.

### Event catalogue (trip room)

| Event | When | Data |
|---|---|---|
| `trip.updated` | Title, dates, visibility changed | changed fields |
| `trip.deleted` | Trip deleted | — (clients leave the room) |
| `day.created` / `day.deleted` | | day |
| `marker.created` / `marker.updated` / `marker.deleted` | | marker (with cover thumbnail URL) |
| `markers.reordered` | Order change or best route applied | dayId, ordered IDs |
| `photo.processing` | Upload confirmed | photo stub |
| `photo.ready` / `photo.failed` | Thumbnail job finished | photo with URLs |
| `photo.deleted` | | photoId, markerId, new cover ID |
| `marker.cover_changed` | Cover chosen, or set automatically by the first ready photo | markerId, photoId |
| `photos.reordered` | Gallery reordered | markerId, ordered photo IDs |
| `comment.created` / `comment.deleted` | | comment (viewer-neutral: `likedByMe` false, `canDelete` false) / commentId, markerId |
| `like.count_changed` | Any like on trip/marker/photo/comment | targetType, targetId, count (throttled per API instance to max 1 per target per 2 s; the trailing event carries the latest count) |
| `member.added` / `member.removed` | | `{ member: { user, role } }` / `{ userId, reason: left\|removed\|blocked }` |

Domain events that don't go to a room as such: `trip.copied` (tripId = the source; data: copyId, ownerId) for a future notification, and `like.count_changed` for places (no trip).

### User room

| Event | Data |
|---|---|
| `notification.created` | notification (as in `GET /notifications`, in the user's saved language). Batched and grouped entries are sent again with the same `id` and a higher `count`: replace by id |
| `trips.changed` | `{ tripId, change: added\|removed }` — trip created (owner and members), added as member, removed/left, trip deleted |
| `account.suspended` | `{}` — an admin suspended the account; the server disconnects every socket of the user right after, and HTTP calls answer 403 `ACCOUNT_SUSPENDED`. Account deletion disconnects the same way, without an event |

## Push notifications (FCM)

Triggered from domain events by the notifications module, executed as BullMQ jobs.

| Type | Recipient | Rule |
|---|---|---|
| `comment_on_marker` | Trip owner and the marker's creator (if different), not the commenter | One push per comment |
| `added_to_trip` | The added user | Includes trip title and who added them |
| `trip_changed_by_collaborator` | Trip owner and editors except the actor | **Batched:** collect for 10 minutes per trip per recipient, then one push ("Jonas added 3 markers to Vienna") |
| `likes_grouped` | Owner of the liked item | **Grouped:** at most one push per recipient per hour summarizing new likes ("12 people liked your photos in Vienna") |

- The API turns domain events into `plan` jobs on the `notifications` queue; the worker picks recipients, writes rows and sends. Recipients never include the actor, anyone with a block either way with the actor, inactive accounts, or anyone who can't view the trip.
- Collaborator changes are: trip updated, day added/deleted, marker added/updated/deleted, markers reordered, photo uploaded. The summary names the latest actor ("Jonas added 3 places", "Jonas made 5 changes", "Jonas and others made 5 changes").
- Grouped likes count people, not likes (a like, unlike and like again counts once); own likes never notify; place likes notify no one. Likes on a trip go to its owner, on a marker to its creator, on a photo to its uploader, on a comment to its author.
- Batched and grouped entries are one row per group (`groupKey`) that collects until its push is sent; the next event opens a new row. The in-app row appears (and updates) immediately; only the push waits.
- At send time the recipient's access is checked again: someone who lost access to the trip gets no push and the entry is deleted. The in-app list also hides entries about trips the user can no longer see, and entries caused by someone they have a block with. Deleting a comment deletes its notifications.
- Respect `notification-settings` per type; still create the in-app notification even if push is off.
- Localize using the recipient's device `locale` (fallback user locale, then `en`). Templates live in the i18n files, keyed `push.<type>.title` / `.body` with ICU plural support.
- Payload: a `notification` (title, body) plus `data: { type, notificationId, deepLink }`. Deep links: `tripinly://markers/{id}` (comments), `tripinly://trips/{id}` (everything else about one trip), `tripinly://notifications` (likes across several trips).
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
