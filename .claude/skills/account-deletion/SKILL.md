---
name: account-deletion
description: Use for Tripinly account deletion (DELETE /me) and GDPR data export (POST /me/export), and whenever a new table or storage path holds user data that must be deleted or exported.
---

# Account deletion and data export

The rules are product decisions in `docs/knowledge/02-domain-rules.md` → "Account deletion". Follow them exactly.

## Deletion flow

1. **Request** `DELETE /me` (recent sign-in required: access token issued within the last 10 minutes, otherwise `REAUTH_REQUIRED` so the client re-signs in with Google/Apple).
2. Capture the provider email for the confirmation email, set `users.status = 'deleting'`, revoke all refresh tokens, disconnect sockets, remove devices. Respond `202 Accepted`. From now on the user can't sign in.
3. Enqueue `account.delete` (worker, idempotent, resumable — each step checks what's already done).

## Worker steps (in order)

| # | Step | Detail |
|---|---|---|
| 1 | Collect storage keys | All photos uploaded by the user anywhere + all photos in trips they own (uploaded by anyone). Save the list to the job state. |
| 2 | Owned trips | Delete every trip owned by the user, **even with other editors**. Cascade days, markers, photos, comments, likes on them, invites, members. Emit `trip.deleted` for each. Set `copiedFromTripId = null` on others' copies (FK does it). |
| 3 | Content in others' trips | Delete the user's photos (fix covers: next photo or null) and comments. Markers they created stay with `createdById = null`. Remove their `trip_members` rows. Emit realtime events so open trips update. |
| 4 | Likes | Delete all likes by the user; collect affected targets and places. |
| 5 | Recompute | Counters on affected trips/markers/photos/comments and `places.popularity` for affected places. |
| 6 | Account rows | Blocks (both directions), notifications (to and from; grouped ones shared with others drop the user instead), entitlements, invites created, devices, refresh tokens, auth identities, data exports. Reports filed keep `reporterId = null`; reports **about** the user or their deleted content are closed (`target_deleted`). |
| 7 | Apple revocation | If an Apple identity exists, call Apple's token revocation endpoint with the stored refresh token. Log success/failure without the token. |
| 8 | Consent proof | Replace consent rows with the minimal retained record defined in `07-security-and-gdpr.md` (keyed user-ID hash, document, version, locale, timestamps), purged after `CONSENT_PROOF_RETENTION_YEARS`. Also delete the RevenueCat customer (`DELETE /v1/subscribers/{app_user_id}` with `REVENUECAT_API_KEY`). |
| 9 | User row | Hold the username in `username_holds` for 30 days, then delete the user row. |
| 9b | Idempotency records | Delete the user's stored POST responses in Redis (`idempotency:{userId}:*`, normally gone after 24 h). |
| 10 | Storage | Enqueue photo file deletion for every collected photo (batched, retried) and delete `exports/{userId}/`. |
| 11 | Email | Send `account_deletion_confirmed` to the captured address, then discard it from job state. |

Steps 2–6 run in transactions per batch (e.g. 100 trips) so a huge account doesn't hold one giant transaction. Storage deletion happens only after the rows are gone.

## What must survive

- Trips and markers **other users copied** (they are independent rows owned by the copier with no photos/comments from the author).
- Markers the user added to other people's trips (without attribution).

## Data export (`POST /me/export`)

- One export at a time per user; rate limit 1 per 24 h.
- Worker builds a ZIP: `profile.json`, `consents.json`, `trips.json` (owned and member trips with days and markers), `comments.json`, `likes.json`, `notifications.json`, `blocks.json` (people the user blocked), `reports.json` (reports the user filed), `photos/` (originals the user uploaded, EXIF already stripped), `README.txt` (localized explanation, `i18n/*/export.json`).
- Upload to `exports/{userId}/{exportId}.zip`, email a signed link valid 7 days, delete the object after 7 days.

## When you add a table or storage path

Update the step table above, `03-data-model.md` (deletion behaviour), and the export contents. Add a test.

## Tests

End-to-end: user A owns a shared trip with editor B; B copied another of A's public trips; A commented and uploaded in C's trip; A liked things. Delete A → A's trips gone, B's copy intact with `copiedFromTripId = null`, A's comments/photos in C's trip gone and cover fixed, A's markers in C's trip kept with no author, counts and popularity recomputed, storage delete jobs enqueued, no rows reference A.
