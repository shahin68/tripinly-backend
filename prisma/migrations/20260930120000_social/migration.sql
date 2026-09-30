-- CreateEnum
CREATE TYPE "LikeTargetType" AS ENUM ('trip', 'marker', 'photo', 'comment', 'place');

-- CreateTable
CREATE TABLE "comments" (
    "id" UUID NOT NULL,
    "markerId" UUID NOT NULL,
    "tripId" UUID NOT NULL,
    "authorId" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "likeCount" INTEGER NOT NULL DEFAULT 0,
    "hiddenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "likes" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "targetType" "LikeTargetType" NOT NULL,
    "targetId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "likes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "comments_markerId_createdAt_id_idx" ON "comments"("markerId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "comments_tripId_idx" ON "comments"("tripId");

-- CreateIndex
CREATE INDEX "comments_authorId_idx" ON "comments"("authorId");

-- CreateIndex
CREATE INDEX "likes_targetType_targetId_idx" ON "likes"("targetType", "targetId");

-- CreateIndex
CREATE UNIQUE INDEX "likes_userId_targetType_targetId_key" ON "likes"("userId", "targetType", "targetId");

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_markerId_fkey" FOREIGN KEY ("markerId") REFERENCES "markers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "trips"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "likes" ADD CONSTRAINT "likes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Likes point at their target by (targetType, targetId), without a foreign key.
-- These triggers delete a target's likes with it, including rows removed by
-- ON DELETE CASCADE (a trip's markers, photos and comments), so no like is orphaned.
CREATE FUNCTION delete_target_likes() RETURNS trigger AS $$
BEGIN
  DELETE FROM likes WHERE "targetType" = TG_ARGV[0]::"LikeTargetType" AND "targetId" = OLD.id;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trips_delete_likes AFTER DELETE ON trips
  FOR EACH ROW EXECUTE FUNCTION delete_target_likes('trip');
CREATE TRIGGER markers_delete_likes AFTER DELETE ON markers
  FOR EACH ROW EXECUTE FUNCTION delete_target_likes('marker');
CREATE TRIGGER photos_delete_likes AFTER DELETE ON photos
  FOR EACH ROW EXECUTE FUNCTION delete_target_likes('photo');
CREATE TRIGGER comments_delete_likes AFTER DELETE ON comments
  FOR EACH ROW EXECUTE FUNCTION delete_target_likes('comment');
CREATE TRIGGER places_delete_likes AFTER DELETE ON places
  FOR EACH ROW EXECUTE FUNCTION delete_target_likes('place');
