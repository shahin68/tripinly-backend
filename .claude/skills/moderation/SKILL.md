---
name: moderation
description: Use for Tripinly reporting, blocking and admin review — report intake, block effects across features, hiding content, suspending users and admin audit logging.
---

# Moderation

App Store and Google Play require apps with user-generated content to let users report content, block users, and act on reports. This is in scope for v1.

## Reporting — `POST /reports`

- Targets: `user`, `trip`, `marker`, `photo`, `comment`. Caller must be able to `view` the target (or it must be a user they can see).
- Reasons: `spam`, `harassment`, `nudity`, `violence`, `hate`, `other` (+ optional details ≤ 1000 chars).
- One open report per reporter per target (repeat → 200, no duplicate).
- Rate limit: 20 reports per user per day.
- Reporting doesn't hide anything automatically (see open questions for thresholds).

## Blocking — `POST/DELETE /users/{id}/block`

Blocking takes effect immediately and in both directions:

- Profiles, trips, markers, photos, comments of the other user disappear from lists, search, Explore, Nearby and Popular spots for the viewer.
- Neither can comment on, like, or copy the other's content, add the other to a trip, or accept the other's invite.
- If they share trips, the non-owner is removed from the owner's trip (both directions), with realtime eviction.
- Pending notifications between them are dropped; future ones aren't created.
- Unblocking restores visibility but not removed memberships.

Implement block filtering through shared helpers (`blockFilter(userId)` for Prisma where-clauses and SQL fragments) so every query applies the same rule. Add a test whenever you add a list endpoint.

## Admin review

- `GET /admin/reports?status=open` — sorted oldest first, includes target snapshot (content + owner username), report count per target.
- `PATCH /admin/reports/{id}` actions:
  - `dismiss`
  - `hide_content` → set `hiddenAt` on the target (trip/marker/photo/comment); hidden content disappears for everyone except admins and a "hidden" state for the author. Recompute popularity if a public marker/trip is hidden.
  - `suspend_user` → `users.status = suspended`, revoke tokens, disconnect sockets; their public content is hidden from discovery while suspended.
  - `delete_content` → hard delete via the normal service (with storage cleanup).
- Resolving one report can resolve all open reports on the same target.
- Every admin action writes an **audit log** entry (admin ID, action, target, time, note).
- Admin role is set manually in the database for now; there's no admin UI in scope — admins use the API (or a simple internal tool later).

## Tests

Report dedupe and rate limit, can't report invisible content, block hides content in each list endpoint, block removes shared membership, admin-only guard, hide_content affects discovery and popularity, audit entry written.
