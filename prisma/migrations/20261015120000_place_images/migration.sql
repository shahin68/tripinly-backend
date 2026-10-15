-- Wikimedia Commons images of places, copied to our storage with their credits.
CREATE TYPE "PlaceImageOrigin" AS ENUM ('wikidata_p18', 'osm_wikimedia_commons', 'osm_image');

CREATE TYPE "PlaceImageStatus" AS ENUM ('pending', 'ready', 'rejected', 'removed', 'hidden');

CREATE TABLE "place_images" (
    "id" UUID NOT NULL,
    "placeId" UUID NOT NULL,
    "origin" "PlaceImageOrigin" NOT NULL,
    "commonsTitle" TEXT NOT NULL,
    "objectName" TEXT,
    "wikidataId" TEXT,
    "rank" INTEGER NOT NULL DEFAULT 0,
    "width" INTEGER,
    "height" INTEGER,
    "mime" TEXT,
    "commonsSha1" TEXT,
    "authorText" TEXT,
    "attributionText" TEXT,
    "licenseShortName" TEXT,
    "licenseUrl" TEXT,
    "attributionRequired" BOOLEAN NOT NULL DEFAULT true,
    "filePageUrl" TEXT,
    "status" "PlaceImageStatus" NOT NULL DEFAULT 'pending',
    "rejectReason" TEXT,
    "fetchedAt" TIMESTAMP(3),
    "checkedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "place_images_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "place_images_placeId_commonsTitle_key" ON "place_images"("placeId", "commonsTitle");

CREATE INDEX "place_images_placeId_status_rank_idx" ON "place_images"("placeId", "status", "rank");

CREATE INDEX "place_images_commonsTitle_idx" ON "place_images"("commonsTitle");

ALTER TABLE "place_images" ADD CONSTRAINT "place_images_placeId_fkey" FOREIGN KEY ("placeId") REFERENCES "places"("id") ON DELETE CASCADE ON UPDATE CASCADE;
