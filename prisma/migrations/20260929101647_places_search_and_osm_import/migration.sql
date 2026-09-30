-- CreateEnum
CREATE TYPE "OsmImportStatus" AS ENUM ('running', 'succeeded', 'degraded', 'failed');

-- AlterTable
ALTER TABLE "places" ADD COLUMN     "osmRegion" TEXT,
ADD COLUMN     "searchText" TEXT NOT NULL DEFAULT '';

-- Backfill: places created before this migration are user places without name variants.
UPDATE "places" SET "searchText" = "normalizedName";

-- CreateTable
CREATE TABLE "osm_import_runs" (
    "id" UUID NOT NULL,
    "region" TEXT NOT NULL,
    "status" "OsmImportStatus" NOT NULL DEFAULT 'running',
    "extractAt" TIMESTAMP(3),
    "seen" INTEGER NOT NULL DEFAULT 0,
    "inserted" INTEGER NOT NULL DEFAULT 0,
    "updated" INTEGER NOT NULL DEFAULT 0,
    "deactivated" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "osm_import_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "osm_import_runs_region_startedAt_idx" ON "osm_import_runs"("region", "startedAt" DESC);

-- CreateIndex
CREATE INDEX "places_search_text_trgm_idx" ON "places" USING GIN ("searchText" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "places_osmRegion_idx" ON "places"("osmRegion");
