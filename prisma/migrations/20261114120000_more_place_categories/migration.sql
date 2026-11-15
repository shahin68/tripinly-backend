-- Place categories for spots and the OSM import (2026-11-14): eight more,
-- next to the ten we had. `other` stays the catch-all, shown as "Spot".
-- Existing OSM places move to the new ones on the next import run.
ALTER TYPE "PlaceCategory" ADD VALUE IF NOT EXISTS 'bakery';
ALTER TYPE "PlaceCategory" ADD VALUE IF NOT EXISTS 'fast_food';
ALTER TYPE "PlaceCategory" ADD VALUE IF NOT EXISTS 'viewpoint';
ALTER TYPE "PlaceCategory" ADD VALUE IF NOT EXISTS 'beach';
ALTER TYPE "PlaceCategory" ADD VALUE IF NOT EXISTS 'entertainment';
ALTER TYPE "PlaceCategory" ADD VALUE IF NOT EXISTS 'shopping';
ALTER TYPE "PlaceCategory" ADD VALUE IF NOT EXISTS 'stay';
ALTER TYPE "PlaceCategory" ADD VALUE IF NOT EXISTS 'transport';
