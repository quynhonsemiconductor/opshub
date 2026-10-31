-- ============================================================================
-- Migration 0043: runtime grants and default privileges for opshub_app /
-- opshub_worker
-- ============================================================================
-- On-prem, CNPG creates `opshub_app`, `opshub_worker` and `opshub_migrator`
-- (managed roles, passwords from Key Vault) and `opshub_migrator` owns the
-- `opshub` database with NO CREATEROLE. Migrations run as `opshub_migrator`,
-- which owns every object it creates, but ownership is not access: the two
-- runtime roles only ever received grants where a migration happened to run
-- its grant block, and a database whose roles the platform created before the
-- first migration received nothing from 0012's CREATE-ROLE-era text.
--
-- This migration re-states the whole runtime grant set, idempotently, so the
-- end state does not depend on which grant block ran first or whether the roles
-- pre-existed: USAGE on each app schema, SELECT/INSERT/UPDATE/DELETE on its
-- tables, USAGE/SELECT on its sequences, and the same two privileges as DEFAULT
-- PRIVILEGES for tables and sequences created later.
--
-- The schema list is DERIVED from ownership — every namespace the role running
-- this migration owns — not hard-coded. Opshub has added schemas after 0012
-- (documents, contracts, door, isms, qms, positions, performance, training …),
-- and a fixed list is a list someone forgets; the same derivation is what
-- db/fresh-db/assert-runtime-privileges.sql asserts against. `drizzle`,
-- `information_schema`, `public` and `pg_*` are excluded because they are not
-- application schemas.
--
-- Default privileges are set FOR the role that grants them — the role running
-- this migration, `current_user`, which on-prem is `opshub_migrator` (the owner,
-- and so the creator of every future table). Naming `opshub_migrator` explicitly
-- would fail on the AWS-era path, where that role does not exist and the master
-- still owns the objects; `current_user` is the same role there.
--
-- ROLE TIMEOUTS ARE NOT SET HERE, deliberately. `ALTER ROLE … SET` on another
-- role needs CREATEROLE (or ADMIN OPTION), which the on-prem migrator does not
-- hold. The platform sets them on the roles it creates; the values this
-- migration's predecessor used are the contract:
--
--   opshub_app     statement_timeout 30s   idle_in_transaction_session_timeout 60s
--   opshub_worker  statement_timeout 120s  idle_in_transaction_session_timeout 180s
--
-- Additive for the grant set, plus the NARROWING re-applied at the end: the
-- blanket table grant is followed by the REVOKEs the per-schema migrations made
-- (reference data and append-only history). Without them this migration would
-- quietly re-open writes the repo deliberately closed — the e2e job's
-- RESTRICTED_TABLES assertion is what caught that, and is what keeps the two
-- lists honest. No DDL, no role creation — safe to run on any database at
-- whatever head it holds.
-- ============================================================================

DO $$
DECLARE
  runtime_roles CONSTANT text[] := ARRAY['opshub_app', 'opshub_worker'];
  present_roles text[] := ARRAY[]::text[];
  role_list text;
  app_schemas text[];
  s text;
  r text;
BEGIN
  FOREACH r IN ARRAY runtime_roles LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      present_roles := present_roles || r;
    END IF;
  END LOOP;

  IF cardinality(present_roles) = 0 THEN
    RAISE EXCEPTION
      'Migration 0043 found none of the runtime roles %. They are provisioned by the platform '
      '(CNPG managed roles on-prem; docs/runbooks/db-role-least-privilege.md on AWS).',
      runtime_roles;
  END IF;

  role_list := array_to_string(ARRAY(SELECT quote_ident(u) FROM unnest(present_roles) AS u), ', ');

  SELECT array_agg(n.nspname ORDER BY n.nspname)
    INTO app_schemas
    FROM pg_namespace n
   WHERE n.nspowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
     AND n.nspname NOT IN ('public', 'drizzle', 'information_schema')
     AND n.nspname NOT LIKE 'pg\_%';

  -- `IS NULL` first: array_agg over nothing is NULL, and `cardinality(NULL) = 0`
  -- is NULL, not true.
  IF app_schemas IS NULL OR cardinality(app_schemas) = 0 THEN
    RAISE EXCEPTION
      'Migration 0043 found no application schema owned by %: the migrations did not run as the '
      'schema owner, or created nothing.',
      current_user;
  END IF;

  FOREACH s IN ARRAY app_schemas LOOP
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO %s', s, role_list);
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO %s', s, role_list
    );
    EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO %s', s, role_list);

    -- Future tables and sequences: covered for whatever creates them from here
    -- on. The GRANTOR is current_user by omission (see the header). Idempotent —
    -- re-running replaces the same rows in pg_default_acl.
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA %I '
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %s', s, role_list
    );
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT USAGE, SELECT ON SEQUENCES TO %s', s, role_list
    );
  END LOOP;
END $$;

-- ── The declared restrictions, re-applied ──────────────────────────────────
-- The blanket GRANT above cannot see INTENT, and the per-schema migrations this
-- restates deliberately narrowed eight tables afterwards with REVOKE — reference
-- data nobody may edit, and append-only history whose row IS the evidence.
-- `ALTER DEFAULT PRIVILEGES` grants writes at CREATE TABLE, so the narrowing has to
-- be re-applied to the tables that exist.
--
-- The list mirrors RESTRICTED_TABLES in db/enable-least-privilege-roles.ts, which
-- every e2e run asserts in BOTH directions (a denied privilege that is held fails
-- the job). That assertion is the tripwire: if this copy and the declared one
-- drift, CI goes red rather than the restriction silently disappearing.
DO $$
DECLARE
  runtime_roles CONSTANT text[] := ARRAY['opshub_app', 'opshub_worker'];
  present_roles text[] := ARRAY[]::text[];
  role_list text;
  r text;
BEGIN
  FOREACH r IN ARRAY runtime_roles LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      present_roles := present_roles || r;
    END IF;
  END LOOP;

  IF cardinality(present_roles) = 0 THEN
    RAISE EXCEPTION 'Migration 0043 (restrictions) found none of the runtime roles %.', runtime_roles;
  END IF;

  role_list := array_to_string(ARRAY(SELECT quote_ident(u) FROM unnest(present_roles) AS u), ', ');

  -- Reference data: the runtime roles read it and never write it.
  IF to_regclass('isms.classification_levels') IS NOT NULL THEN
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON isms.classification_levels FROM %s', role_list);
  END IF;
  IF to_regclass('isms.vendor_criticality_levels') IS NOT NULL THEN
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON isms.vendor_criticality_levels FROM %s', role_list);
  END IF;
  IF to_regclass('qms.nonconformance_severities') IS NOT NULL THEN
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON qms.nonconformance_severities FROM %s', role_list);
  END IF;
  IF to_regclass('workforce.leave_policies') IS NOT NULL THEN
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON workforce.leave_policies FROM %s', role_list);
  END IF;
  IF to_regclass('performance.rating_scale') IS NOT NULL THEN
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON performance.rating_scale FROM %s', role_list);
  END IF;

  -- Append-only history: rows may be added, never rewritten or removed.
  IF to_regclass('isms.asset_classification_history') IS NOT NULL THEN
    EXECUTE format('REVOKE UPDATE, DELETE ON isms.asset_classification_history FROM %s', role_list);
  END IF;
  IF to_regclass('isms.incident_events') IS NOT NULL THEN
    EXECUTE format('REVOKE UPDATE, DELETE ON isms.incident_events FROM %s', role_list);
  END IF;
  IF to_regclass('isms.vendor_assessments') IS NOT NULL THEN
    EXECUTE format('REVOKE UPDATE, DELETE ON isms.vendor_assessments FROM %s', role_list);
  END IF;
END $$;
