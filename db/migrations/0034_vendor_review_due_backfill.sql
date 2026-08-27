-- Backfill: isms.vendors.review_due_on, for suppliers whose criticality was corrected
--
-- WHY ANY ROW IS WRONG. `review_due_on` is the review cadence: the last assessment date plus the
-- tier's `review_interval_months`. `VendorService.assess` has always written it, and nothing else
-- did — so `PATCH /v1/vendors/:id` could move a supplier from `low` (36 months) to `critical` (6)
-- and leave the stored date on the old schedule. Everything that means "overdue" reads that column:
-- the review-gap report, the `reviewDueOnOrBefore` list filter, the register screen and the daily
-- reminder sweep. A supplier raised to `critical` therefore stayed absent from all four until their
-- next assessment — which is the assessment the shorter cadence existed to pull forward. The service
-- now recomputes on a criticality change; this fixes the rows written before it did.
--
-- RECOMPUTED, NOT REPAIRED FROM HISTORY. There is nothing to repair from: no API accepts
-- `review_due_on`, so the column has never held a human decision, only the arithmetic. Every row is
-- therefore set to what that arithmetic says today.
--
-- THE ARITHMETIC IS THE SAME ARITHMETIC. `assessed_at + n * interval '1 month'`, cast to date, in
-- Postgres — character for character what `VendorDrizzleRepository.setReviewDueOn` emits. A JS
-- `setUTCMonth` and `+ interval '1 month'` disagree at month ends (31 January plus one month), so a
-- backfill written the other way would introduce a new class of one-day disagreement while removing
-- this one.
--
-- "LATEST" IS THE SAME LATEST. `DISTINCT ON (vendor_id) ... ORDER BY assessed_at DESC, id DESC`
-- matches the `latestAssessment` subquery the register, the report and the go-live gate all read,
-- including the `id` tiebreaker that decides which of a bulk import's identical timestamps counts.
--
-- ROWS WITH NO ASSESSMENT ARE LEFT ALONE, including any that carry a due date anyway. Only an import
-- or a seed could have put one there, this migration knows nothing about where it came from, and both
-- shapes — a null date and a past one — are already reported as gaps. Nulling them would trade a
-- date somebody chose for no information at all.
--
-- TERMINATED SUPPLIERS ARE INCLUDED. The invariant is about the column, not about who is reported on,
-- and leaving a subset deliberately wrong is how the next reader learns not to trust it.
--
-- THIS ALSO PICKS UP A CHANGED TIER INTERVAL, and that is deliberate. `review_interval_months` is
-- reference data; changing it does NOT re-date suppliers already assessed (see `reviewGaps` on
-- `IVendorRepository`) precisely because "a policy change that must apply immediately is a
-- migration". This is that migration. If a tier's interval has been edited since the rows were
-- written, the new cadence takes effect here.
--
-- `updated_at` IS NOT TOUCHED. It answers "when was this supplier's record last changed", and the
-- answer is not "the release that corrected our own arithmetic" — there is no audit entry for this
-- either, for the same reason.

WITH latest AS (
  SELECT DISTINCT ON (va.vendor_id) va.vendor_id, va.assessed_at
  FROM isms.vendor_assessments va
  ORDER BY va.vendor_id, va.assessed_at DESC, va.id DESC
),
recomputed AS (
  SELECT v.id,
         ((latest.assessed_at + (l.review_interval_months * interval '1 month'))::date) AS due_on
  FROM isms.vendors v
  JOIN isms.vendor_criticality_levels l ON l.code = v.criticality
  JOIN latest ON latest.vendor_id = v.id
)
UPDATE isms.vendors v
SET review_due_on = r.due_on
FROM recomputed r
WHERE r.id = v.id
  -- `IS DISTINCT FROM` rather than `<>`: the row that matters most is the one whose stored date is
  -- NULL, and `<>` would skip exactly that one.
  AND v.review_due_on IS DISTINCT FROM r.due_on;
