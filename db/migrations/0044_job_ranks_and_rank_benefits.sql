-- Job ranks and rank benefits: the seniority a position carries, and what that seniority entitles.
--
-- `positions.positions.level` is free text ("Level 2", "L2", "lvl 2"), so nothing can hang a benefit off it:
-- a lookup by that string would match some spellings and miss the rest. A rank is a row instead, ordered by
-- `ordinal` (1 = most junior), and `rank_benefits` holds what each rank entitles its holders to — one row per
-- (rank, benefit). The first benefit is `wfh_weekly_days`, the days a holder may work from home in one
-- Monday–Sunday week.
--
-- This migration only ADDS the two tables. `positions.level` is replaced by a rank reference in the next one.
-- Additive and idempotent, same style as 0041/0042. The runtime roles reach both tables through the default
-- privileges migration 0043 re-stated for this schema.

DO $$ BEGIN
  CREATE TYPE "public"."rank_benefit_code" AS ENUM ('wfh_weekly_days');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS positions.job_ranks (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Seniority order, 1 = most junior. Unique: one rank per step.
  ordinal    integer NOT NULL,
  name       varchar(80) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_job_rank_ordinal CHECK (ordinal >= 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_job_rank_ordinal ON positions.job_ranks (ordinal);
CREATE UNIQUE INDEX IF NOT EXISTS uq_job_rank_name ON positions.job_ranks (lower(name));

CREATE TABLE IF NOT EXISTS positions.rank_benefits (
  rank_id      uuid NOT NULL REFERENCES positions.job_ranks (id) ON DELETE CASCADE,
  benefit_code rank_benefit_code NOT NULL,
  -- The amount; the unit is named by the code (wfh_weekly_days → days per week).
  value        integer NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (rank_id, benefit_code),
  CONSTRAINT ck_rank_benefit_value CHECK (value >= 0)
);
