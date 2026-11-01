-- Social pushes (decided 2026-11-01): follows, friends, accepted join requests, saved trips and spots getting hot.
ALTER TYPE "NotificationType" ADD VALUE 'followed';
ALTER TYPE "NotificationType" ADD VALUE 'became_friends';
ALTER TYPE "NotificationType" ADD VALUE 'join_accepted';
ALTER TYPE "NotificationType" ADD VALUE 'trip_saved';
ALTER TYPE "NotificationType" ADD VALUE 'place_hot';

-- AlterTable
ALTER TABLE "notification_settings" ADD COLUMN "newFollowers" BOOLEAN NOT NULL DEFAULT true;
