-- Profile photos (decided 2026-10-31): a photo with neither a stop nor a place is a profile photo.
ALTER TABLE "photos" DROP CONSTRAINT "photos_marker_or_place_check";
ALTER TABLE "photos" ADD CONSTRAINT "photos_marker_or_place_check" CHECK (
  ("markerId" IS NOT NULL AND "tripId" IS NOT NULL AND "placeId" IS NULL)
  OR ("markerId" IS NULL AND "tripId" IS NULL AND "placeId" IS NOT NULL)
  OR ("markerId" IS NULL AND "tripId" IS NULL AND "placeId" IS NULL)
);

-- AlterTable
ALTER TABLE "users" ADD COLUMN "avatarPhotoId" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "users_avatarPhotoId_key" ON "users"("avatarPhotoId");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_avatarPhotoId_fkey" FOREIGN KEY ("avatarPhotoId") REFERENCES "photos"("id") ON DELETE SET NULL ON UPDATE CASCADE;
