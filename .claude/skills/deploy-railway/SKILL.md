---
name: deploy-railway
description: Use for Tripinly environments and deployment on Railway — services, environment variables, PostGIS setup, migrations as a release step, health checks, rollbacks and domains.
---

# Deploying on Railway

## Services per environment (staging, production)

| Service | Start command | Notes |
|---|---|---|
| `api` | `node dist/main.js` | Public domain; health check `/v1/health/ready` |
| `worker` | `node dist/main.worker.js` | No public domain |
| `postgres` | PostGIS-enabled Postgres 16 | Enable `postgis` in the first migration |
| `redis` | Railway Redis | |

Both `api` and `worker` build from the same repo and Dockerfile (multi-stage: install → `prisma generate` → `nest build` → slim runtime).

## Release steps

1. CI: install, lint, typecheck, unit + integration tests (Testcontainers), build.
2. Deploy to **staging** first.
3. Migrations run once as a pre-deploy command on the `api` service: `npx prisma migrate deploy`. The worker never runs migrations.
4. Migrations must be backward compatible with the currently running version (expand → migrate → contract across releases), because old instances keep serving during the rollout.
5. Smoke test staging: `/v1/health/ready`, sign-in with a test account, create trip, add marker, upload photo, receive realtime event.
6. Promote to **production** only when the user says so.

## Environment variables

The full list is in `docs/knowledge/06-architecture-and-infra.md`. Rules:
- Set them in Railway per environment; use Railway reference variables for `DATABASE_URL` and `REDIS_URL`.
- Staging and production use **separate** R2 buckets, Firebase projects, Resend domains/keys and Apple/Google client configuration where possible.
- Never print variables in build logs.
- When adding a variable: add it to the config schema (boot fails if missing), to `06-architecture-and-infra.md`, and tell the user which value to set in Railway.

## Operations

- **Rollback:** redeploy the previous successful deployment in Railway. Because migrations are backward compatible, the previous version can run against the new schema.
- **Scaling:** more `api` replicas are fine (Redis adapter for Socket.IO, stateless HTTP). WebSockets need sticky sessions only if long-polling is enabled; prefer websocket-only transport from the KMP client.
- **Backups:** confirm Railway Postgres backups are enabled for production; test a restore to staging before launch.
- **Custom domain:** `api.<domain>` on the `api` service; HTTPS certificates are managed by Railway.

## Things you can't do yourself

You don't have access to the user's Railway account. Prepare Dockerfile, config and exact instructions; the user runs them or grants access explicitly.
