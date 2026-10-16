-- Place photos (decided 2026-10-16, B1-B3): a photo on a place instead of a trip stop.
-- AlterTable
ALTER TABLE "photos" ALTER COLUMN "markerId" DROP NOT NULL,
ALTER COLUMN "tripId" DROP NOT NULL,
ADD COLUMN     "placeId" UUID;

-- A trip photo has a marker and a trip; a place photo has only a place.
ALTER TABLE "photos" ADD CONSTRAINT "photos_marker_or_place_check" CHECK (
  ("markerId" IS NOT NULL AND "tripId" IS NOT NULL AND "placeId" IS NULL)
  OR ("markerId" IS NULL AND "tripId" IS NULL AND "placeId" IS NOT NULL)
);

-- DropIndex
DROP INDEX "photos_uploaderId_idx";

-- CreateIndex
CREATE INDEX "photos_uploaderId_createdAt_idx" ON "photos"("uploaderId", "createdAt");

-- CreateIndex
CREATE INDEX "photos_placeId_likeCount_createdAt_idx" ON "photos"("placeId", "likeCount" DESC, "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "photos" ADD CONSTRAINT "photos_placeId_fkey" FOREIGN KEY ("placeId") REFERENCES "places"("id") ON DELETE CASCADE ON UPDATE CASCADE;
