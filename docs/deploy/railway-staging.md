# Railway staging: step by step

This sets up the **staging** environment: Postgres with PostGIS, Redis, and two services built from this repository (`api` and `worker`). Production is the same later, with its own values, once Shahin says so.

Values marked 🔑 are secrets. Paste them only into Railway (or Cloudflare / Firebase), never into chat, issues or commits.

## 0. Before you start

You need:
- the Railway account, connected to GitHub with access to `shahin68/tripinly-backend`;
- a terminal with `openssl` (macOS and Linux have it) to generate three secrets;
- for photos: a Cloudflare account (step 3);
- optional: the openrouteservice key, the RevenueCat secret key, the Firebase service account JSON.

## 1. Project and databases

1. Railway → **New Project** → **Empty project**. Name it `tripinly`. Railway creates the `production` environment; add another with the environment switcher at the top → **New environment** → `staging`, and work in `staging` from here on.
2. **+ Create** → **Template** → search **PostGIS** → deploy it. (Railway's plain Postgres has no PostGIS; our first migration needs it.) Rename the service to `postgres`.
3. **+ Create** → **Database** → **Redis**. Rename it to `redis`.

## 2. Secrets you generate yourself

Run each once and keep the output only until it's pasted into Railway:

```sh
openssl rand -base64 48   # JWT_ACCESS_SECRET
openssl rand -base64 32   # ENCRYPTION_KEY  (never change it later: it decrypts stored Apple tokens)
openssl rand -hex 32      # DEV_AUTH_SECRET (staging only)
```

## 3. Photo storage (Cloudflare R2)

1. Cloudflare dashboard → **R2 Object Storage** → enable R2 (the free tier covers staging; it asks for a card).
2. **Create bucket** → name `tripinly-staging`, location automatic. Leave public access **off**.
3. R2 → **Manage API tokens** → **Create API token** → permission **Object Read & Write**, limited to the bucket `tripinly-staging`. Create it and keep the page open: it shows the **Access Key ID** 🔑 and **Secret Access Key** 🔑 once.
4. Note your **Account ID** (R2 overview page, right side).

## 4. Shared variables (used by both services)

Project → **Settings** → **Shared Variables** → environment `staging` → add:

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `DEPLOY_ENV` | `staging` |
| `LOG_LEVEL` | `info` |
| `JWT_ACCESS_SECRET` 🔑 | from step 2 |
| `ENCRYPTION_KEY` 🔑 | from step 2 |
| `R2_ACCOUNT_ID` | from step 3 |
| `R2_ACCESS_KEY_ID` 🔑 | from step 3 |
| `R2_SECRET_ACCESS_KEY` 🔑 | from step 3 |
| `R2_BUCKET` | `tripinly-staging` |

## 5. The `api` service

1. **+ Create** → **GitHub Repo** → `shahin68/tripinly-backend`. Rename the service to `api`.
2. Service → **Settings**:
   - **Source → Branch:** `develop` (staging follows develop).
   - **Build:** Dockerfile (Railway picks up the `Dockerfile` at the repository root).
   - **Deploy → Custom Start Command:** `node dist/main.js`.
   - **Deploy → Pre-deploy Command:** `npx prisma migrate deploy`. Migrations run before every deploy; without it the database stays empty.
   - **Deploy → Healthcheck Path:** `/v1/health/ready`, timeout `120` seconds.
   - **Deploy → Restart Policy:** On Failure, 5 retries.
   - Railway's config files (Config as Code) are closed to new services, so these settings are entered by hand.
   - **Networking → Generate Domain.** That's the staging API address until there's a real domain.
3. Service → **Variables**:
   - **Add all shared variables** (button at the top of the variables list).
   - `DATABASE_URL` → **Add Reference** → `postgres` → `DATABASE_URL`.
   - `REDIS_URL` → **Add Reference** → `redis` → `REDIS_URL`.
   - `DEV_AUTH_ENABLED` = `true` and `DEV_AUTH_SECRET` 🔑 = from step 2 (test sign-in while Google and Apple aren't set up; refused on production).
   - `ORS_API_KEY` 🔑 = your openrouteservice key (optional; without it routes are straight lines). Leave `ORS_BASE_URL` unset: it defaults to `https://api.heigit.org/openrouteservice`, and keys from the openrouteservice dashboard work there.
4. **Deploy.** The first deploy runs all migrations.

## 6. The `worker` service

1. **+ Create** → **GitHub Repo** → the same repository. Rename it to `worker`.
2. **Settings:** branch `develop`; **Custom Start Command:** `node dist/main.worker.js` (without it the service runs the image's default command, which is the api); **Restart Policy:** On Failure, 5 retries. No pre-deploy command, no healthcheck, no domain.
3. **Variables:**
   - all shared variables, plus `DATABASE_URL` and `REDIS_URL` references as for `api`;
   - `OSM_IMPORT_ENABLED` = `true` (loads Austria and Hungary places on first start, then monthly; the first import takes a while and downloads a few hundred MB);
   - `REVENUECAT_API_KEY` 🔑 = your RevenueCat secret key (optional; account deletion deletes the RevenueCat customer with it);
   - `FIREBASE_SERVICE_ACCOUNT_JSON` 🔑 = the whole service account JSON (optional; without it no pushes).
4. **Deploy.**

Email (`RESEND_API_KEY`, `EMAIL_FROM`) waits for the domain; until then emails are skipped with a warning.

## 7. Legal documents (once)

Onboarding needs published Terms and Privacy documents. Staging uses placeholders until the real ones exist:

```sh
npm i -g @railway/cli && railway login
railway link            # pick tripinly → staging → api
railway ssh -- npm run db:seed
```

`railway ssh` needs an SSH key: if it says none was found, run `ssh-keygen -t ed25519`, accept the defaults, run the command again and let it register the key. If the seed reports that `legal_documents` does not exist, the migrations haven't run: run `railway ssh -- npx prisma migrate deploy` first and check the api's pre-deploy command.

## 8. Smoke test

From a checkout of this repository (`npm ci` once):

```sh
DEV_AUTH_SECRET=<the staging value> node scripts/smoke-test.mjs https://<api domain>
```

On Windows `cmd`, set the secret on its own line first (no quotes, no trailing space): `set DEV_AUTH_SECRET=<value>`, then `node scripts/smoke-test.mjs https://<api domain>`. In PowerShell: `$env:DEV_AUTH_SECRET="<value>"`.

If dev sign-in answers 404, `DEV_AUTH_ENABLED=true` is missing on the api or the secret doesn't match. If photos time out, check that the worker runs `node dist/main.worker.js` (its logs must not show `Mapped {/v1/...} route` lines).

It checks health, test sign-in, onboarding, a trip and marker with a live event, a photo upload processed by the worker, a route, and deletes its test account at the end. Every line should show ✓.

## 9. Test accounts for the apps

```sh
DEV_AUTH_SECRET=<the staging value> node scripts/seed-test-accounts.mjs https://<api domain>
```

(On Windows, set the secret first as in step 8.) It signs in two developer accounts, `tester` and `tester2`, finishes their onboarding, deletes the trips they own and creates the same three again: **Vienna weekend** (public, 2 days, 5 stops), **Budapest with a friend** (private, `tester2` is an editor) and **Empty trip**. In a debug build of the app, use the developer sign-in with subject `tester` or `tester2`. Run it again whenever you want the known starting data back.

## Checklist of every value

| Where | Variable | Status |
|---|---|---|
| Shared | `NODE_ENV`, `DEPLOY_ENV`, `LOG_LEVEL`, `R2_BUCKET` | plain values |
| Shared | `JWT_ACCESS_SECRET`, `ENCRYPTION_KEY` | generated (step 2) |
| Shared | `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | Cloudflare (step 3) |
| api + worker | `DATABASE_URL`, `REDIS_URL` | Railway references |
| api | `DEV_AUTH_ENABLED`, `DEV_AUTH_SECRET` | staging only |
| api | `ORS_API_KEY` | you hold it |
| worker | `REVENUECAT_API_KEY` | you hold it |
| worker | `FIREBASE_SERVICE_ACCOUNT_JSON` | from Firebase, when ready |
| worker | `OSM_IMPORT_ENABLED` | `true` |
| later | `RESEND_API_KEY`, `EMAIL_FROM`, `GOOGLE_CLIENT_IDS`, `APPLE_*`, `APP_LINK_BASE_URL`, `REVENUECAT_WEBHOOK_AUTH` | need the domain, developer accounts or the webhook |
