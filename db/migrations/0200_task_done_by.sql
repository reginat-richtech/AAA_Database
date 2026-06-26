-- =====================================================================
-- AAA_Database :: TASK "done by" attribution
-- Target: PostgreSQL 16+   Depends on the ext.task table (Task Tracking).
--
-- Records WHO marked a task done and WHEN. Used by the Project Tracker's Team
-- Preparation step: each of the 3 department prep tasks (tech / sales / inventory)
-- can be marked done only by that department's manager (or an admin), and we keep
-- the marker's name + email so downstream steps (calendar, Technician Confirmation)
-- know who handled each part. Self-contained + idempotent.
-- =====================================================================
CREATE SCHEMA IF NOT EXISTS ext;

ALTER TABLE ext.task ADD COLUMN IF NOT EXISTS done_by_email text;
ALTER TABLE ext.task ADD COLUMN IF NOT EXISTS done_by_name  text;
ALTER TABLE ext.task ADD COLUMN IF NOT EXISTS done_at       timestamptz;
