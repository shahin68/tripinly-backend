-- People can like a place's Commons images, which show in its Photos list
-- after its people's photos. The images stay single rows: nothing is copied.
ALTER TYPE "LikeTargetType" ADD VALUE 'place_image';

ALTER TABLE "place_images" ADD COLUMN "likeCount" INTEGER NOT NULL DEFAULT 0;

-- A deleted image takes its likes with it, like every other like target.
CREATE TRIGGER place_images_delete_likes AFTER DELETE ON place_images
  FOR EACH ROW EXECUTE FUNCTION delete_target_likes('place_image');
