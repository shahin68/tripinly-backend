-- Save and Join replace copying trips (decided 2026-10-16): no trip is ever duplicated.
-- CreateEnum
CREATE TYPE "JoinRequestStatus" AS ENUM ('pending', 'declined');

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'join_requested';

-- DropForeignKey
ALTER TABLE "trips" DROP CONSTRAINT "trips_copiedFromTripId_fkey";

-- AlterTable
ALTER TABLE "trips" DROP COLUMN "copiedFromTripId",
DROP COLUMN "copyCount";

-- AlterTable
ALTER TABLE "notification_settings" ADD COLUMN     "joinRequested" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "trip_saves" (
    "tripId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trip_saves_pkey" PRIMARY KEY ("tripId","userId")
);

-- CreateTable
CREATE TABLE "trip_join_requests" (
    "id" UUID NOT NULL,
    "tripId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "status" "JoinRequestStatus" NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "trip_join_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "trip_saves_userId_idx" ON "trip_saves"("userId");

-- CreateIndex
CREATE INDEX "trip_join_requests_tripId_status_createdAt_idx" ON "trip_join_requests"("tripId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "trip_join_requests_userId_idx" ON "trip_join_requests"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "trip_join_requests_tripId_userId_key" ON "trip_join_requests"("tripId", "userId");

-- AddForeignKey
ALTER TABLE "trip_saves" ADD CONSTRAINT "trip_saves_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "trips"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_saves" ADD CONSTRAINT "trip_saves_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_join_requests" ADD CONSTRAINT "trip_join_requests_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "trips"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_join_requests" ADD CONSTRAINT "trip_join_requests_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
