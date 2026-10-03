# Tripinly — Security and GDPR

## Authentication

- **Google:** verify the ID token signature, `iss`, `exp` and that `aud` is one of `GOOGLE_CLIENT_IDS`. Identity key = `sub`.
- **Apple:** verify the identity token against Apple's JWKS (`iss = https://appleid.apple.com`, `aud = APPLE_BUNDLE_ID`). Identity key = `sub`. Exchange the authorization code for an Apple refresh token and store it **encrypted**; it's needed to revoke the Apple session when the account is deleted (Apple requires this).
- Apple may only share the email on first sign-in and may give a private relay address; never rely on email as the identity key.
- **Access token:** JWT, 15 minutes, claims `sub`, `role`, `onb` (onboarded), `auth_time` (when the user last signed in with Google/Apple; a refresh keeps it), `iat`, `exp`, `jti`.
- **Recent sign-in:** `DELETE /me` needs `auth_time` within the last 10 minutes, else 403 `REAUTH_REQUIRED` (the client signs in again, then retries).
- **Refresh token:** random 256-bit value, stored as a hash, 60 days, **rotated on every refresh**. Tokens share a `familyId`; presenting an already-rotated token revokes the whole family (`REFRESH_TOKEN_REUSED`) and the user must sign in again.
- Suspended users: refresh fails with `ACCOUNT_SUSPENDED`; open sockets are disconnected.
- **Ending live sessions:** suspension and account deletion revoke every refresh token and mark the user in Redis (`auth:revoked:{userId}`) for one access-token lifetime, so still-valid access tokens are refused at once (`ACCOUNT_SUSPENDED`, or `UNAUTHENTICATED` after deletion). If Redis is down the check fails open and the account status and revoked refresh tokens end access within 15 minutes.
- Admin endpoints require `role = admin` checked by a guard (against the database, not the token claim) **and** audited in `admin_audit_logs` (who did what, when, why).

## Authorization

- Trip-scoped access goes through `TripAccessService` (see `trip-access` skill). Return 404, not 403, for resources the caller isn't allowed to know exist.
- Block checks apply to reads and writes.
- IDs from the client are never trusted: always load the parent and check.

## Input and uploads

- DTO validation with whitelist + forbid unknown properties.
- Uploads go directly to R2 via pre-signed PUT URLs (10 minutes) that sign the declared content type and length; the object key is generated server-side (`photos/{photoId}/original`). `complete` re-checks the stored size.
- The worker refuses files whose bytes aren't the declared type and images over 50 megapixels (decompression bombs).
- On `complete`, the worker downloads the original, checks the real MIME type (magic bytes), strips EXIF (including GPS), generates thumbnail (e.g. 256 px) and display (e.g. 1600 px) versions in WebP/JPEG, then marks the photo `ready`.
- Rate limit comments, likes, uploads, search, auth and report endpoints.

## Personal data inventory

| Data | Why | Retention |
|---|---|---|
| Display name, username | Profile, search | Until account deletion |
| Birth date | Age check (16+) and legal compliance | Until account deletion; never shown to other users |
| Provider email | Account emails (export, deletion confirmation) | Until deletion; used once more for the deletion confirmation, then discarded |
| Photos (EXIF stripped) | Core feature | Until deleted by user or account deletion |
| Trips, markers, comments, likes | Core feature | Until deleted |
| Consent records | Proof of consent (GDPR Art. 7(1); kept under Art. 17(3)(e) for defending legal claims) | After deletion keep only a minimal record: keyed hash of the user ID, document type, version, locale, granted/withdrawn timestamps. Kept for `CONSENT_PROOF_RETENTION_YEARS` (default **5**, the Hungarian general limitation period), then purged by a job. The value is configuration so legal counsel can change it without code changes. |
| Device tokens, locale | Push | Until logout, token invalid (removed when FCM reports it unregistered), or deletion |
| In-app notifications, notification settings | Activity list, push preferences | Until account deletion (received ones and ones the user caused are deleted; grouped ones shared with others drop the user); deleted with the trip, marker or comment they are about |
| Data export ZIPs | Access / portability | 7 days in R2, then deleted by the hourly sweep |
| Reports filed, admin audit log | Moderation, accountability | Reports stay without the reporter after their deletion; audit entries stay without the admin after theirs |
| Email address in email jobs | Sending one transactional email | Only while the job runs; removed from Redis when it finishes or fails, never logged. The account deletion job holds the address from its start until the confirmation is queued |
| Responses to content-creating POSTs sent with an `Idempotency-Key` | Replaying a retried request instead of creating a duplicate | 24 hours in Redis (`idempotency:{userId}:{key}`), never logged; purged by account deletion |
| Current location (Nearby) | Query only | **Not stored, not logged** |
| IP addresses in logs | Security | Short log retention (e.g. 14 days) |

## GDPR rights

- **Access / portability:** `POST /me/export` builds a ZIP (`profile.json` with sign-in methods, devices without tokens, paid features and settings; `consents.json`; `trips.json` with days and markers; `comments.json`; `likes.json`; `notifications.json`; `blocks.json` (people the user blocked); `reports.json` (reports the user filed); `photos/` originals the user uploaded, already without EXIF; a localized `README.txt`), stores it in R2, emails a signed link valid 7 days, then deletes the ZIP. One at a time, one per 24 hours. `GET /me/export` returns the latest with a fresh link while it lasts.
- **Erasure:** `DELETE /me` — see `02-domain-rules.md` and the `account-deletion` skill. Complete within 30 days (aim: minutes). A failed deletion job is retried every hour until it finishes. Deleting and exporting stay open while a consent is owed.
- **Rectification:** profile editing.
- **Withdraw consent:** withdrawing a required consent means the user must delete the account or stop using the app; the API blocks use with `CONSENT_REQUIRED`.
- **Children:** under-16 sign-ups are rejected and nothing about them is stored.

## Secrets and logging

- Secrets only in Railway variables; never in the repo, never in logs, never in error responses.
- Error responses never include stack traces or SQL in production.
- Logs exclude: tokens, emails, birth dates, coordinates, signed URLs, comment bodies.
