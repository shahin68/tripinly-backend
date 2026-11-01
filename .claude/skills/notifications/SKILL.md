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
   - **Every type is immediate** (Shahin, 2026-11-01): create the in-app `notifications` row, enqueue `push.send`.
   - **Repeats** (likes, collaborator changes): first claim the Redis key `notifications:repeat:{recipient}:{actor}:{kind}:{item}` with `SET NX EX NOTIFICATION_REPEAT_COOLDOWN_SECONDS`; if it's taken, the same thing already notified within the cooldown, so skip (a like, unlike and like again pushes once). If Redis fails, send.
4. Emit `notification.created` to `user:{recipientId}` for the in-app list.

## Sending push

- Look up the recipient's devices; skip if the per-type setting is off (in-app row still created).
- Localize per device `locale` → user locale → `en`, with `nestjs-i18n` keys `push.<type>.title` / `push.<type>.body`, ICU plurals for counts ("{count, plural, one {# person} other {# people}} liked…").
- Data payload: `{ type, notificationId, deepLink }`. Every push says what happened and where, and opens that place: `tripinly://markers/{id}` for anything about one stop (set the row's `markerId`), `tripinly://trips/{id}/members`, `tripinly://users/{username}`, else `tripinly://trips/{id}` (table in `05-realtime-and-notifications.md`).
- A new type maps to an existing switch group in `SETTING_FOR_TYPE` unless Shahin wants a new switch. Pushes cost money: anything that can fire many times (flames, follows) gets a cooldown or a milestone, never one push per tap.
- List the edge cases in the plan and test them: target deleted before the job runs (never write a `markerId` of a stop that's gone), blocks either way, lost access, inactive accounts, toggling (cooldowns), the switch off.
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
5. Tests: recipient selection, actor excluded, blocked excluded, a repeat within the cooldown produces one push, setting off → no push but in-app row exists.
