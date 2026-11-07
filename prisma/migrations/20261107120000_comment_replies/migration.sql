-- Replies and @mentions in comments (decided 2026-11-07).
ALTER TYPE "NotificationType" ADD VALUE 'comment_reply';
ALTER TYPE "NotificationType" ADD VALUE 'comment_mention';

-- AlterTable
ALTER TABLE "comments" ADD COLUMN "parentId" UUID;

-- CreateTable
CREATE TABLE "comment_mentions" (
    "commentId" UUID NOT NULL,
    "userId" UUID NOT NULL,

    CONSTRAINT "comment_mentions_pkey" PRIMARY KEY ("commentId","userId")
);

-- CreateIndex
CREATE INDEX "comments_markerId_likeCount_createdAt_id_idx" ON "comments"("markerId", "likeCount", "createdAt", "id");

-- CreateIndex
CREATE INDEX "comments_parentId_createdAt_id_idx" ON "comments"("parentId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "comment_mentions_userId_idx" ON "comment_mentions"("userId");

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "comments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comment_mentions" ADD CONSTRAINT "comment_mentions_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "comments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comment_mentions" ADD CONSTRAINT "comment_mentions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
