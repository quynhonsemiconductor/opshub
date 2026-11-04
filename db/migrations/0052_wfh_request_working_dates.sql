-- The working days a WFH request covers, frozen on the request.
--
-- `working_days` already froze HOW MANY days a request covers, because the holiday calendar is editable and a
-- later declaration inside an approved window must not restate what was approved. The weekly quota also needs
-- WHICH days, to know which week each one falls in: it recomputed them from the CURRENT holiday calendar at
-- every read, so declaring a holiday after a request was filed silently changed what the request had claimed
-- (and with it how many days an employee had left in the week). `working_dates` freezes the dates too.
--
-- Existing rows: their dates are derived here from the calendar as it stands, which is the best a migration
-- can do (the calendar at filing time is not recorded). A weekend or holiday never counts.
--
-- Additive and idempotent: the backfill runs only in the migration that adds the column.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'workforce' AND table_name = 'wfh_requests' AND column_name = 'working_dates'
  ) THEN
    ALTER TABLE workforce.wfh_requests ADD COLUMN working_dates date[] NOT NULL DEFAULT '{}';

    UPDATE workforce.wfh_requests r
    SET working_dates = COALESCE((
      SELECT array_agg(d::date ORDER BY d)
      FROM generate_series(r.start_date::timestamp, r.end_date::timestamp, interval '1 day') AS d
      WHERE extract(isodow FROM d) < 6
        AND NOT EXISTS (SELECT 1 FROM workforce.holidays h WHERE h.date = d::date)
    ), '{}');
  END IF;
END
$$;
