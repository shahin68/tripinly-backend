---
name: database-change
description: Use for any Tripinly schema change — Prisma schema edits, migrations, indexes, PostGIS columns, backfills and denormalized counters.
---

# Database changes

## Rules

- Migrations are **forward-only**. Never edit or delete a migration that may have been applied anywhere; create a new one.
- Every change must keep `docs/knowledge/03-data-model.md` accurate — update it in the same change.
- Deletion behaviour (`onDelete`) must match the table in `03-data-model.md` and the account-deletion rules. If you add a table that references `users`, decide explicitly what happens on user deletion and add it to that table and to the `account-deletion` skill.

## Steps

1. Edit `prisma/schema.prisma`.
2. Generate: `npx prisma migrate dev --name <short_snake_case_description> --create-only`.
3. Open the generated SQL and review it:
   - PostGIS columns are `geography(Point,4326)`; Prisma writes them as `Unsupported(...)`, so add the column and a **GiST index** in SQL by hand if needed: `CREATE INDEX ... USING GIST (location);`
   - Partial indexes (e.g. `WHERE visibility = 'public' AND "hiddenAt" IS NULL`) and `text_pattern_ops` indexes must be written in SQL.
   - Adding a `NOT NULL` column to a populated table: add nullable → backfill → set `NOT NULL` in a later migration, or give a default.
   - Large tables: create indexes with `CONCURRENTLY` in a separate migration (Prisma runs migrations in a transaction by default; split accordingly).
4. Apply locally: `npx prisma migrate dev`, then `npx prisma generate`.
5. **Backfills** of existing data run as an idempotent script or BullMQ job, not inside the migration, unless trivially small.
6. **Denormalized counters** (`likeCount`, `commentCount`, `copyCount`, `places.popularity`): update them in the same transaction as the write, and provide a recompute job that can rebuild them from source rows (used after account deletion and visibility changes).
7. Add or update test factories in `test/factories/`.
8. Run the full integration test suite.

## Spatial queries

- Always parameterize: `prisma.$queryRaw\`... ST_DWithin(location, ST_MakePoint(${lng}, ${lat})::geography, ${radiusM})\``. Never build SQL with string concatenation.
- Note PostGIS takes **longitude first** in `ST_MakePoint(lng, lat)`.
- Bounding boxes: `location && ST_MakeEnvelope(minLng, minLat, maxLng, maxLat, 4326)::geography`.
