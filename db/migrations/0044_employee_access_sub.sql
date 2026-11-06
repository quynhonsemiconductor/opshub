-- ============================================================================
-- Migration 0044: bind the first verified Cloudflare Access `sub` to an employee
-- ============================================================================
-- MCP maps the Access JWT to an employee by email. Email is the pragmatic key
-- (the origin JWT carries no usable `oid`), but a mailbox can be reassigned:
-- without a binding, the new holder of an address would inherit every MCP grant
-- the old holder had. The Access `sub` is stable for one identity at this team,
-- so the FIRST verified sub to reach an employee is stored here and every later
-- call must match it — a mismatch is the same uniform 403 as an unknown employee
-- (opshub MCP-PLAN P3, KB parity: kb#388).
--
-- Nullable: everyone who has never used MCP has no sub. The unique index is
-- partial so multiple NULLs are fine while a bound sub belongs to exactly one
-- employee (two addresses resolving to one Access identity is a configuration
-- error and fails closed rather than sharing an envelope).
-- ============================================================================

ALTER TABLE identity.employees
  ADD COLUMN IF NOT EXISTS access_sub varchar(255);

CREATE UNIQUE INDEX IF NOT EXISTS uq_employee_access_sub
  ON identity.employees (access_sub)
  WHERE access_sub IS NOT NULL;
