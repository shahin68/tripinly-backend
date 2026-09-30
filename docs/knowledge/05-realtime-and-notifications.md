# Tripinly — Real Time and Notifications

## Real time (Socket.IO)

- Namespace `/v1/realtime`. Clients connect with the access token in the handshake `auth.token`; the server verifies it and rejects expired tokens (client reconnects after refreshing).
- Redis adapter so several API instances share rooms.
- Rooms:
  - `user:{userId}` — joined automatically on connect. Personal notifications, trip list changes.
  - `trip:{tripId}` — joined via `trip.subscribe { tripId }`. The server runs the `TripAccessService` read check before joining; leave with `trip.unsubscribe`.
- Events are **notifications of change with enough data to update the UI**, not a replacement for REST. On reconnect, clients refetch the trip.
- Every event payload: `{ "event": "...", "tripId": "...", "actorId": "...", "at": "ISO", "data": { ... } }`.
- The actor's own socket also receives events (clients de-duplicate by entity ID).
- Blocked users are never delivered events caused by the user they blocked (or who blocked them).

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
| `comment.created` / `comment.deleted` | | comment |
| `like.count_changed` | Any like on trip/marker/photo/comment | targetType, targetId, count (throttled to max 1 per target per 2 s) |
| `member.added` / `member.removed` | | user summary |

### User room

| Event | Data |
|---|---|
| `notification.created` | notification |
| `trips.changed` | Added to / removed from a trip |
| `account.suspended` | — |

## Push notifications (FCM)

Triggered from domain events by the notifications module, executed as BullMQ jobs.

| Type | Recipient | Rule |
|---|---|---|
| `comment_on_marker` | Trip owner and the marker's creator (if different), not the commenter | One push per comment |
| `added_to_trip` | The added user | Includes trip title and who added them |
| `trip_changed_by_collaborator` | Trip owner and editors except the actor | **Batched:** collect for 10 minutes per trip per recipient, then one push ("Jonas added 3 markers to Vienna") |
| `likes_grouped` | Owner of the liked item | **Grouped:** at most one push per recipient per hour summarizing new likes ("12 people liked your photos in Vienna") |

- Respect `notification-settings` per type; still create the in-app notification even if push is off.
- Localize using the recipient's device `locale` (fallback user locale, then `en`). Templates live in the i18n files, keyed `push.<type>.title` / `.body` with ICU plural support.
- Payload includes a deep-link path (`tripinly://trips/{id}`, `tripinly://markers/{id}`) and the notification ID.
- Remove device tokens that FCM reports as unregistered.
- Never include private trip content in a push to someone who isn't a member.

## Email

Transactional only, via Resend, localized templates:

| Email | When |
|---|---|
| `data_export_ready` | Export job finished; contains a signed download link valid 7 days |
| `account_deletion_confirmed` | Deletion finished (sent to the provider email captured before deletion, then the address is discarded) |

No marketing email in v1.
