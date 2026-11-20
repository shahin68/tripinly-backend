-- CreateEnum
CREATE TYPE "BrandLogoSource" AS ENUM ('wikimedia', 'upload');

-- AlterTable
ALTER TABLE "places" ADD COLUMN     "brandId" UUID;

-- CreateTable
CREATE TABLE "brands" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "wikidataId" TEXT,
    "logo" BYTEA,
    "logoHash" TEXT,
    "logoSource" "BrandLogoSource",
    "commonsTitle" TEXT,
    "logoCheckedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "brands_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "brands_wikidataId_key" ON "brands"("wikidataId");

-- CreateIndex
CREATE INDEX "places_brandId_idx" ON "places"("brandId");

-- AddForeignKey
ALTER TABLE "places" ADD CONSTRAINT "places_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "brands"("id") ON DELETE SET NULL ON UPDATE CASCADE;
