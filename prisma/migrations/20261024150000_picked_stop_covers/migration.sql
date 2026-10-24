-- A stop's cover is picked from its photo grid: one of the trip's photos, a
-- popular photo of the place (which other trips may pick too) or one of the
-- place's Commons images. Unpicked, the pin shows the place's own image.
DROP INDEX "markers_coverPhotoId_key";
CREATE INDEX "markers_coverPhotoId_idx" ON "markers"("coverPhotoId");

ALTER TABLE "markers" ADD COLUMN "coverImageId" UUID;
ALTER TABLE "markers" ADD CONSTRAINT "markers_coverImageId_fkey"
  FOREIGN KEY ("coverImageId") REFERENCES "place_images"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "markers_coverImageId_idx" ON "markers"("coverImageId");
