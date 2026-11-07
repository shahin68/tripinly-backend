-- Grouped notifications (2026-11-07): a key may have several rows (one per
-- read group), so the old one-open-row-per-key index goes.
DROP INDEX IF EXISTS "notifications_open_group_key";
