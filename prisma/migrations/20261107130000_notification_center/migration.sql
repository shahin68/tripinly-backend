-- The notification center (decided 2026-11-07): seen state, and two new kinds.
ALTER TYPE "NotificationType" ADD VALUE 'join_declined';
ALTER TYPE "NotificationType" ADD VALUE 'removed_from_trip';

-- AlterTable
ALTER TABLE "users" ADD COLUMN "notificationsSeenAt" TIMESTAMP(3);

-- Everything before the center existed counts as seen.
UPDATE "users" SET "notificationsSeenAt" = CURRENT_TIMESTAMP;

-- Grouped entries (one per liked item or hot spot) are found by their key.
CREATE INDEX "notifications_groupKey_idx" ON "notifications"("groupKey");
