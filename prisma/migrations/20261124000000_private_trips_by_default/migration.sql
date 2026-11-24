-- New accounts start with private trips (Shahin, 2026-11-24). Accounts that exist keep the setting they have.
ALTER TABLE "users" ALTER COLUMN "defaultTripVisibility" SET DEFAULT 'private';
