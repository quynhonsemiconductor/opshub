-- Index the identity 8 account lookup by provider (identity 8.4.1, reference DDL).
--
-- Better Auth looks an account up by (provider_id, account_id) on every Microsoft sign-in, and generates no index
-- for that pair; identity 8.4.1 adds this one to its reference schema. Without it the lookup scans identity.account.
--
-- Plain CREATE INDEX, not CONCURRENTLY: the drizzle migrator runs every migration inside one transaction, and
-- CONCURRENTLY cannot run in a transaction block. identity.account holds one row per linked sign-in method (one
-- per staff member at most, today), so the write lock taken while the index builds is brief.
--
-- Additive and idempotent: no column or constraint changes, safe with the old api still running.

CREATE INDEX IF NOT EXISTS "account_provider_account_idx" ON "identity"."account" USING btree ("provider_id","account_id");
