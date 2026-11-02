-- A position's seniority becomes a job rank: `positions.level` (free text) is replaced by `rank_id`.
--
-- Free text cannot carry a benefit — "Level 2", "L2" and "lvl 2" are three spellings of one thing, and a
-- lookup by the string matches only one of them. `positions.job_ranks` (0044) is the table the text becomes.
--
-- THE BACKFILL, so no existing level is lost: every DISTINCT non-blank level (compared case-insensitively,
-- trimmed) becomes a rank, and each position is pointed at the rank of its own level. The ordinals this gives
-- are only an alphabetical placeholder, appended after any rank that already exists: free text carries no
-- seniority order, so HR must put the ranks in their real order afterwards. Benefits are not invented here
-- either; a rank has none until HR sets them.
--
-- A position with no level keeps a NULL `rank_id`. The reference is ON DELETE RESTRICT: a rank in use cannot
-- be deleted out from under the positions that carry it.
--
-- Idempotent: the backfill and the drop run only while the old column exists.

ALTER TABLE positions.positions
  ADD COLUMN IF NOT EXISTS rank_id uuid REFERENCES positions.job_ranks (id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS ix_position_rank ON positions.positions (rank_id);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'positions' AND table_name = 'positions' AND column_name = 'level'
  ) THEN
    INSERT INTO positions.job_ranks (ordinal, name)
    SELECT COALESCE((SELECT max(ordinal) FROM positions.job_ranks), 0)
             + row_number() OVER (ORDER BY lower(distinct_levels.level_name)),
           distinct_levels.level_name
      FROM (
        SELECT DISTINCT ON (lower(btrim(level))) btrim(level) AS level_name
          FROM positions.positions
         WHERE btrim(COALESCE(level, '')) <> ''
         ORDER BY lower(btrim(level)), btrim(level)
      ) AS distinct_levels
     WHERE NOT EXISTS (
       SELECT 1 FROM positions.job_ranks existing
        WHERE lower(existing.name) = lower(distinct_levels.level_name)
     );

    UPDATE positions.positions p
       SET rank_id = r.id
      FROM positions.job_ranks r
     WHERE p.rank_id IS NULL
       AND lower(r.name) = lower(btrim(p.level));

    ALTER TABLE positions.positions DROP COLUMN level;
  END IF;
END $$;
