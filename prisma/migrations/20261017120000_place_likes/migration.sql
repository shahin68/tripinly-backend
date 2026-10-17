-- Likes belong to places (E1): a stop's like is a like on its place, one per
-- person per place. Existing stop likes move to their places, the earliest kept.
INSERT INTO likes (id, "userId", "targetType", "targetId", "createdAt")
SELECT gen_random_uuid(), l."userId", 'place', m."placeId", min(l."createdAt")
FROM likes l JOIN markers m ON m.id = l."targetId"
WHERE l."targetType" = 'marker'
GROUP BY l."userId", m."placeId"
ON CONFLICT ("userId", "targetType", "targetId") DO NOTHING;

DELETE FROM likes WHERE "targetType" = 'marker';

ALTER TABLE markers DROP COLUMN "likeCount";

-- Popularity is now the place's likes, counted for a user-made place only while
-- a public, visible trip has it (see src/modules/places/popularity.ts).
UPDATE places p SET popularity = c.popularity
FROM (
  SELECT pl.id, CASE
    WHEN pl.source = 'osm' OR EXISTS (
      SELECT 1 FROM markers m JOIN trips t ON t.id = m."tripId"
      WHERE m."placeId" = pl.id AND m."hiddenAt" IS NULL
        AND t.visibility = 'public' AND t."hiddenAt" IS NULL)
    THEN (SELECT count(*) FROM likes l WHERE l."targetType" = 'place' AND l."targetId" = pl.id)::int
    ELSE 0 END AS popularity
  FROM places pl
  WHERE pl.popularity > 0 OR EXISTS (
    SELECT 1 FROM likes l WHERE l."targetType" = 'place' AND l."targetId" = pl.id)
) c
WHERE p.id = c.id AND p.popularity <> c.popularity;
