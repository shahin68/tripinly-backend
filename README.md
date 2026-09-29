# Tripinly backend

REST API (`/v1`), real-time server and background worker for Tripinly, a social travel-planning app. The Kotlin Multiplatform apps consume the API through the generated OpenAPI document (`openapi.json`, also served at `/v1/openapi.json`).

- **Stack:** Node 24, NestJS 12, TypeScript, PostgreSQL 16 + PostGIS via Prisma 7, Redis, Socket.IO, BullMQ. Hosted on Railway.
- **Agent instructions:** `CLAUDE.md`. **Knowledge base:** `docs/knowledge/`. **Skills:** `.claude/skills/`.

## Local development

Requirements: Node 24 (`.nvmrc`) and Docker.

```bash
cp .env.example .env
docker compose up -d db redis     # PostGIS 16 and Redis
npm ci
npx prisma migrate deploy         # applies migrations
npx prisma generate               # generates the Prisma client into src/generated
npm run start:dev                 # http://localhost:3000/v1/health, docs at /v1/docs
```

The worker runs with `npm run build && npm run start:worker`. `docker compose up` builds the image and runs migrations, api and worker together.

## Checks

| Command | What it does |
|---|---|
| `npm run format:check` / `npm run format` | Prettier |
| `npm run lint` | oxlint (type-aware) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Unit tests (`src/**/*.spec.ts`) |
| `npm run test:integration` | Integration tests (`test/integration`) against real PostGIS and Redis started with Testcontainers. Set `TEST_DATABASE_URL` and `TEST_REDIS_URL` to reuse running services instead. |
| `npm run build && npm run openapi` | Regenerates `openapi.json`; CI fails if it is stale |

## Database

Schema changes follow the `database-change` skill: edit `prisma/schema.prisma`, run `npx prisma migrate dev --name <change>`, and commit the migration. Migrations are forward-only.

## Deployment

One Docker image serves both Railway services: `api` (`node dist/main.js`, health check `/v1/health/ready`) and `worker` (`node dist/main.worker.js`). The release step runs `npx prisma migrate deploy`. See the `deploy-railway` skill.

## Git workflow

Feature branch → pull request into `develop`. Nothing is pushed to `master` directly.
