-- AlterTable
ALTER TABLE "trips" ADD COLUMN     "destinationLat" DOUBLE PRECISION,
ADD COLUMN     "destinationLng" DOUBLE PRECISION,
ADD COLUMN     "destinationName" TEXT;

-- A destination has a name and a location, or nothing at all.
ALTER TABLE "trips" ADD CONSTRAINT "trips_destination_complete" CHECK (
  ("destinationName" IS NULL AND "destinationLat" IS NULL AND "destinationLng" IS NULL)
  OR ("destinationName" IS NOT NULL AND "destinationLat" IS NOT NULL AND "destinationLng" IS NOT NULL)
);
