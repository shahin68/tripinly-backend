-- A user place remembers who made it, credited as "added by" while they have it
-- in a public trip. Account deletion clears it.
ALTER TABLE "places" ADD COLUMN "createdById" UUID;
ALTER TABLE "places" ADD CONSTRAINT "places_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Existing user places: whoever added their first stop.
UPDATE "places" p SET "createdById" = first."createdById"
FROM (
  SELECT DISTINCT ON ("placeId") "placeId", "createdById"
  FROM "markers"
  WHERE "createdById" IS NOT NULL
  ORDER BY "placeId", "createdAt", id
) first
WHERE p.id = first."placeId" AND p.source = 'user';
