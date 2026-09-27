---
name: notifications
description: Use for Tripinly push notifications (FCM), in-app notifications and transactional email — triggers, batching and grouping of likes and collaborator changes, localization, deep links and device token hygiene.
---

# Notifications

Rules and the type table live in `docs/knowledge/05-realtime-and-notifications.md`.

## Pipeline

1. A service emits a domain event (`comment.created`, `member.added`, `marker.created`, `like.created`, …).
2. `NotificationPlanner` (listener) decides **recipients** and **type**:
   - exclude the actor
   - exclude anyone with a block relation to the actor
   - exclude recipients who can no longer `view` the trip
3. For each recipient:
   - **Immediate types** (`comment_on_marker`, `added_to_trip`): create the in-app `notifications` row, enqueue `push.send`.
   - **Batched** (`trip_changed_by_collaborator`): upsert a row with `groupKey = trip:{tripId}:changes:{recipientId}` and increment `count` / collect actor names; enqueue a **delayed** job (10 min) with a deterministic job ID so repeated events don't create more jobs. When it runs, send one push summarizing and close the group.
   - **Grouped likes** (`likes_grouped`): same pattern with `groupKey = likes:{recipientId}` and a 1 h window; never one push per like.
4. Emit `notification.created` to `user:{recipientId}` for the in-app list.

## Sending push

- Look up the recipient's devices; skip if the per-type setting is off (in-app row still created).
- Localize per device `locale` → user locale → `en`, with `nestjs-i18n` keys `push.<type>.title` / `push.<type>.body`, ICU plurals for counts ("{count, plural, one {# person} other {# people}} liked…").
- Data payload: `{ type, notificationId, deepLink }`, deep links `tripinly://trips/{id}`, `tripinly://markers/{id}`.
- Use FCM multicast; delete tokens reported as `registration-token-not-registered` / invalid.
- Never include private trip names or comment text for recipients who aren't members (shouldn't happen after step 2, but check again when sending).
- Keep bodies short; truncate comment excerpts to ~80 chars.

## Email (Resend)

- Only `data_export_ready` and `account_deletion_confirmed` in v1.
- Localized templates in `i18n/<lang>/email.json` plus a simple HTML layout; plain-text alternative always included.
- Sent from the worker; retries with backoff; never log the address.

## Adding a new notification type

1. Confirm with the user that the product wants it (it changes user experience).
2. Add it to the table in `05-realtime-and-notifications.md` with recipient and batching rule.
3. Add i18n keys for **every** supported language.
4. Add a per-type setting in `notification-settings` (default on unless told otherwise).
5. Tests: recipient selection, actor excluded, blocked excluded, batching produces one push, setting off → no push but in-app row exists.
