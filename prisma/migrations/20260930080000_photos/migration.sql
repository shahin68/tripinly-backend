-- CreateEnum
CREATE TYPE "PhotoStatus" AS ENUM ('pending_upload', 'processing', 'ready', 'failed');

-- AlterTable
ALTER TABLE "markers" ADD COLUMN     "coverPhotoId" UUID;

-- CreateTable
CREATE TABLE "photos" (
    "id" UUID NOT NULL,
    "markerId" UUID NOT NULL,
    "tripId" UUID NOT NULL,
    "uploaderId" UUID NOT NULL,
    "status" "PhotoStatus" NOT NULL DEFAULT 'pending_upload',
    "mimeType" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "position" INTEGER NOT NULL,
    "likeCount" INTEGER NOT NULL DEFAULT 0,
    "hiddenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "photos_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "photos_markerId_position_idx" ON "photos"("markerId", "position");

-- CreateIndex
CREATE INDEX "photos_tripId_idx" ON "photos"("tripId");

-- CreateIndex
CREATE INDEX "photos_uploaderId_idx" ON "photos"("uploaderId");

-- CreateIndex
CREATE INDEX "photos_status_updatedAt_idx" ON "photos"("status", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "markers_coverPhotoId_key" ON "markers"("coverPhotoId");

-- AddForeignKey
ALTER TABLE "markers" ADD CONSTRAINT "markers_coverPhotoId_fkey" FOREIGN KEY ("coverPhotoId") REFERENCES "photos"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "photos" ADD CONSTRAINT "photos_markerId_fkey" FOREIGN KEY ("markerId") REFERENCES "markers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "photos" ADD CONSTRAINT "photos_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "trips"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "photos" ADD CONSTRAINT "photos_uploaderId_fkey" FOREIGN KEY ("uploaderId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

