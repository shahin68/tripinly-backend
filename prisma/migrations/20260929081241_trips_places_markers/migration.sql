-- CreateEnum
CREATE TYPE "TripRole" AS ENUM ('owner', 'editor');

-- CreateEnum
CREATE TYPE "PlaceCategory" AS ENUM ('cafe', 'restaurant', 'bar', 'attraction', 'museum', 'historic', 'park', 'nature', 'landmark', 'other');

-- CreateEnum
CREATE TYPE "PlaceSource" AS ENUM ('osm', 'user');

-- CreateEnum
CREATE TYPE "OsmType" AS ENUM ('node', 'way', 'relation');

-- CreateTable
CREATE TABLE "trips" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "startDate" DATE,
    "endDate" DATE,
    "visibility" "TripVisibility" NOT NULL,
    "copiedFromTripId" UUID,
    "likeCount" INTEGER NOT NULL DEFAULT 0,
    "copyCount" INTEGER NOT NULL DEFAULT 0,
    "hiddenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "trips_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trip_members" (
    "id" UUID NOT NULL,
    "tripId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" "TripRole" NOT NULL,
    "addedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trip_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trip_days" (
    "id" UUID NOT NULL,
    "tripId" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trip_days_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trip_invites" (
    "id" UUID NOT NULL,
    "tripId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdById" UUID NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trip_invites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "places" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "names" JSONB NOT NULL DEFAULT '{}',
    "category" "PlaceCategory" NOT NULL DEFAULT 'other',
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    -- Generated from lat/lng so Prisma writes plain columns and PostGIS gets an indexed point.
    "location" geography(Point,4326) GENERATED ALWAYS AS ((st_setsrid(st_makepoint(lng, lat), 4326))::geography) STORED,
    "source" "PlaceSource" NOT NULL,
    "osmType" "OsmType",
    "osmId" BIGINT,
    "tags" JSONB NOT NULL DEFAULT '{}',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "importedAt" TIMESTAMP(3),
    "popularity" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "places_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "markers" (
    "id" UUID NOT NULL,
    "dayId" UUID NOT NULL,
    "tripId" UUID NOT NULL,
    "placeId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    -- Generated from lat/lng so Prisma writes plain columns and PostGIS gets an indexed point.
    "location" geography(Point,4326) GENERATED ALWAYS AS ((st_setsrid(st_makepoint(lng, lat), 4326))::geography) STORED,
    "time" TEXT,
    "position" INTEGER NOT NULL,
    "createdById" UUID,
    "copiedFromMarkerId" UUID,
    "likeCount" INTEGER NOT NULL DEFAULT 0,
    "commentCount" INTEGER NOT NULL DEFAULT 0,
    "hiddenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "markers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blocks" (
    "id" UUID NOT NULL,
    "blockerId" UUID NOT NULL,
    "blockedId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "blocks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "trips_ownerId_idx" ON "trips"("ownerId");

-- CreateIndex
CREATE INDEX "trips_explore_idx" ON "trips"("visibility", "likeCount" DESC) WHERE ((visibility = 'public'::"TripVisibility") AND ("hiddenAt" IS NULL));

-- CreateIndex
CREATE INDEX "trip_members_userId_idx" ON "trip_members"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "trip_members_tripId_userId_key" ON "trip_members"("tripId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "trip_days_tripId_position_key" ON "trip_days"("tripId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "trip_invites_tokenHash_key" ON "trip_invites"("tokenHash");

-- CreateIndex
CREATE INDEX "trip_invites_tripId_idx" ON "trip_invites"("tripId");

-- CreateIndex
CREATE INDEX "places_location_idx" ON "places" USING GIST ("location");

-- CreateIndex
CREATE INDEX "places_location_popular_idx" ON "places" USING GIST ("location") WHERE (popularity > 0);

-- CreateIndex
CREATE INDEX "places_normalized_name_trgm_idx" ON "places" USING GIN ("normalizedName" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "places_popularity_idx" ON "places"("popularity" DESC);

-- CreateIndex
CREATE INDEX "places_category_idx" ON "places"("category");

-- CreateIndex
CREATE UNIQUE INDEX "places_osmType_osmId_key" ON "places"("osmType", "osmId");

-- CreateIndex
CREATE INDEX "markers_dayId_position_idx" ON "markers"("dayId", "position");

-- CreateIndex
CREATE INDEX "markers_tripId_idx" ON "markers"("tripId");

-- CreateIndex
CREATE INDEX "markers_placeId_idx" ON "markers"("placeId");

-- CreateIndex
CREATE INDEX "markers_createdById_idx" ON "markers"("createdById");

-- CreateIndex
CREATE INDEX "markers_location_idx" ON "markers" USING GIST ("location");

-- CreateIndex
CREATE INDEX "blocks_blockedId_idx" ON "blocks"("blockedId");

-- CreateIndex
CREATE UNIQUE INDEX "blocks_blockerId_blockedId_key" ON "blocks"("blockerId", "blockedId");

-- AddForeignKey
ALTER TABLE "trips" ADD CONSTRAINT "trips_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trips" ADD CONSTRAINT "trips_copiedFromTripId_fkey" FOREIGN KEY ("copiedFromTripId") REFERENCES "trips"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_members" ADD CONSTRAINT "trip_members_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "trips"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_members" ADD CONSTRAINT "trip_members_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_members" ADD CONSTRAINT "trip_members_addedById_fkey" FOREIGN KEY ("addedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_days" ADD CONSTRAINT "trip_days_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "trips"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_invites" ADD CONSTRAINT "trip_invites_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "trips"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_invites" ADD CONSTRAINT "trip_invites_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "markers" ADD CONSTRAINT "markers_dayId_fkey" FOREIGN KEY ("dayId") REFERENCES "trip_days"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "markers" ADD CONSTRAINT "markers_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "trips"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "markers" ADD CONSTRAINT "markers_placeId_fkey" FOREIGN KEY ("placeId") REFERENCES "places"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "markers" ADD CONSTRAINT "markers_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "markers" ADD CONSTRAINT "markers_copiedFromMarkerId_fkey" FOREIGN KEY ("copiedFromMarkerId") REFERENCES "markers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_blockerId_fkey" FOREIGN KEY ("blockerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_blockedId_fkey" FOREIGN KEY ("blockedId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
