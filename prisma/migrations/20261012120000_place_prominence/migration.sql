-- How well known a place is (QRank and OSM tags), filled by the OSM import.
ALTER TABLE "places" ADD COLUMN "prominence" SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE "places" ADD COLUMN "qrank" INTEGER;
ALTER TABLE "places" ADD COLUMN "imageTagsHash" TEXT;
