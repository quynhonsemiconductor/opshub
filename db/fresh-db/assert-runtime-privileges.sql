-- Asserts the post-migration privilege state of ONE database, from the outside:
-- what the runtime roles can and cannot do once every migration has run.
--
--   psql -v ON_ERROR_STOP=1 -v creator=<role the migrations ran as> \
--        -d <database> -f db/fresh-db/assert-runtime-privileges.sql
--
-- `creator` is the role that applied the migrations — opshub_migrator on the
-- on-prem shape, the superuser/master on the AWS-era shape — and therefore the
-- GRANTOR of the default privileges and the creator of every future table.
--
-- Every check raises, so a broken input fails the script (ON_ERROR_STOP). Runs
-- as a superuser or a role that may SET ROLE: it switches into the runtime roles
-- rather than reasoning about them.
--
-- Ported from rova's db/fresh-db/assert-runtime-privileges.sql (#832/#833), with
-- opshub's role names, probe schema and boot tables.

\set ON_ERROR_STOP on

\if :{?creator}
\else
  \echo 'usage: psql -v creator=<role the migrations ran as> -f db/fresh-db/assert-runtime-privileges.sql'
  \quit 1
\endif

-- psql does not substitute :variables inside a dollar-quoted DO block, so the
-- creator is handed to those blocks through a temp table.
DROP TABLE IF EXISTS assert_creator;
CREATE TEMP TABLE assert_creator AS
  SELECT :'creator'::regrole AS role, :'creator'::regrole::oid AS role_oid;

-- A previous run that aborted before its cleanup leaves this behind, and the
-- exhaustive check below would then fail on a table the run itself created.
DROP TABLE IF EXISTS storage.fresh_db_privilege_probe;
DROP SEQUENCE IF EXISTS storage.fresh_db_privilege_probe_seq;

-- ── 0. The app schemas, from the DATABASE, once ─────────────────────────────
-- Derived, not listed: 0012 and 0043 write these names (0043 derives them at
-- runtime), and a copy here would be one more place to forget. The migrator owns
-- every schema it creates, so ownership identifies them on both paths, with the
-- namespaces it owns but that are not application schemas excluded — plus
-- `pg_*`, which includes the temp schema this very script uses.
--
-- Computed ONCE into a temp table and read by every check below. A copy of this
-- query per check would also copy the empty case, in which `nspname = ANY(NULL)`
-- matches nothing and an exhaustive check passes vacuously; here the empty case
-- fails, and there is nothing to re-derive.
DROP TABLE IF EXISTS assert_schemas;
CREATE TEMP TABLE assert_schemas AS
  SELECT n.nspname AS schema_name
    FROM pg_namespace n
   WHERE n.nspowner = (SELECT role_oid FROM assert_creator)
     AND n.nspname NOT IN ('public', 'drizzle', 'information_schema')
     AND n.nspname NOT LIKE 'pg\_%';

DO $$
DECLARE
  app_schemas text[];
BEGIN
  SELECT array_agg(schema_name ORDER BY schema_name) INTO app_schemas FROM assert_schemas;
  -- `IS NULL` first: array_agg over nothing is NULL, and `cardinality(NULL) = 0` is NULL, not true.
  IF app_schemas IS NULL OR cardinality(app_schemas) = 0 THEN
    RAISE EXCEPTION
      'no application schema is owned by %: the migrations did not run as this role, or created nothing',
      (SELECT role FROM assert_creator);
  END IF;
  RAISE NOTICE '  app schemas (owned by %): %', (SELECT role FROM assert_creator), app_schemas;
END $$;

-- The restrictions the migrations DECLARE (db/enable-least-privilege-roles.ts,
-- RESTRICTED_TABLES — asserted on every e2e run in both directions). Reference
-- data nobody may edit, and append-only history whose row IS the evidence.
-- Privileges NOT listed here must be held; listed ones must not.
DROP TABLE IF EXISTS assert_restricted;
CREATE TEMP TABLE assert_restricted (schema_name text, table_name text, privilege text);
INSERT INTO assert_restricted VALUES
  ('isms', 'classification_levels', 'INSERT'), ('isms', 'classification_levels', 'UPDATE'), ('isms', 'classification_levels', 'DELETE'),
  ('isms', 'vendor_criticality_levels', 'INSERT'), ('isms', 'vendor_criticality_levels', 'UPDATE'), ('isms', 'vendor_criticality_levels', 'DELETE'),
  ('qms', 'nonconformance_severities', 'INSERT'), ('qms', 'nonconformance_severities', 'UPDATE'), ('qms', 'nonconformance_severities', 'DELETE'),
  ('workforce', 'leave_policies', 'INSERT'), ('workforce', 'leave_policies', 'UPDATE'), ('workforce', 'leave_policies', 'DELETE'),
  ('performance', 'rating_scale', 'INSERT'), ('performance', 'rating_scale', 'UPDATE'), ('performance', 'rating_scale', 'DELETE'),
  ('isms', 'asset_classification_history', 'UPDATE'), ('isms', 'asset_classification_history', 'DELETE'),
  ('isms', 'incident_events', 'UPDATE'), ('isms', 'incident_events', 'DELETE'),
  ('isms', 'vendor_assessments', 'UPDATE'), ('isms', 'vendor_assessments', 'DELETE');

-- ── 1. The grant set is COMPLETE, and EXACTLY as declared ───────────────────
-- One privilege per check, never a comma list: has_table_privilege's multi-word
-- form answers "holds ANY of these", so `'SELECT,INSERT,UPDATE,DELETE'` is true
-- for a role that can only INSERT — which is exactly the broken state this gate
-- exists to catch.
--
-- BOTH directions matter. A missing privilege breaks a feature loudly; an EXTRA
-- one breaks an invariant silently, and a reference table or an append-only
-- history that quietly became writable is the failure this repo keeps finding.
DO $$
DECLARE
  app_schemas text[] := (SELECT array_agg(schema_name) FROM assert_schemas);
  table_privileges CONSTANT text[] := ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'];
  sequence_privileges CONSTANT text[] := ARRAY['USAGE', 'SELECT'];
  -- Granted by OWNERSHIP, never by the runtime roles' grant set. Their presence
  -- would mean the split is decorative: TRUNCATE empties a table, and REFERENCES
  -- lets a role create foreign keys that hold other tables hostage.
  forbidden_table_privileges CONSTANT text[] := ARRAY['TRUNCATE', 'REFERENCES', 'TRIGGER'];
  r text;
  p text;
  missing text[];
  held text[];
  wrong text[];
BEGIN

  FOREACH r IN ARRAY ARRAY['opshub_app', 'opshub_worker'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      RAISE EXCEPTION 'runtime role % does not exist after all migrations ran', r;
    END IF;

    FOREACH p IN ARRAY table_privileges LOOP
      -- Held where nothing declares it denied…
      SELECT coalesce(array_agg(format('%I.%I', n.nspname, c.relname)), '{}')
        INTO missing
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = ANY(app_schemas)
         AND c.relkind IN ('r', 'p')
         AND NOT has_table_privilege(r, c.oid, p)
         AND NOT EXISTS (
               SELECT 1 FROM assert_restricted a
                WHERE a.schema_name = n.nspname AND a.table_name = c.relname AND a.privilege = p
             );
      IF cardinality(missing) > 0 THEN
        RAISE EXCEPTION '% lacks % on % table(s): %', r, p, cardinality(missing), missing;
      END IF;

      -- …and NOT held where it is declared denied.
      SELECT coalesce(array_agg(format('%I.%I', n.nspname, c.relname)), '{}')
        INTO wrong
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN assert_restricted a
          ON a.schema_name = n.nspname AND a.table_name = c.relname AND a.privilege = p
       WHERE n.nspname = ANY(app_schemas)
         AND c.relkind IN ('r', 'p')
         AND has_table_privilege(r, c.oid, p);
      IF cardinality(wrong) > 0 THEN
        RAISE EXCEPTION
          '% holds % on % table(s) that declare it denied — a restriction is not enforced: %',
          r, p, cardinality(wrong), wrong;
      END IF;
    END LOOP;

    -- pg_sequence, not pg_class with relkind = 'S': the planner is free to
    -- evaluate has_sequence_privilege before the relkind filter, and it errors on
    -- the first non-sequence oid it is handed (a TOAST table).
    FOREACH p IN ARRAY sequence_privileges LOOP
      SELECT coalesce(array_agg(format('%I.%I', n.nspname, c.relname)), '{}')
        INTO missing
        FROM pg_sequence sq
        JOIN pg_class c ON c.oid = sq.seqrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = ANY(app_schemas)
         AND NOT has_sequence_privilege(r, sq.seqrelid, p);
      IF cardinality(missing) > 0 THEN
        RAISE EXCEPTION '% lacks % on % sequence(s): %', r, p, cardinality(missing), missing;
      END IF;
    END LOOP;

    FOREACH p IN ARRAY forbidden_table_privileges LOOP
      SELECT coalesce(array_agg(format('%I.%I', n.nspname, c.relname)), '{}')
        INTO held
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = ANY(app_schemas)
         AND c.relkind IN ('r', 'p')
         AND has_table_privilege(r, c.oid, p);
      IF cardinality(held) > 0 THEN
        RAISE EXCEPTION
          '% holds % on % table(s) — a runtime role must not: %', r, p, cardinality(held), held;
      END IF;
    END LOOP;
  END LOOP;
END $$;

-- ── 2. The grant set is USABLE: a real query as each role ────────────────────
-- has_table_privilege can be true while the schema is unusable; a statement
-- cannot. One table per schema the app boots against.
\echo '  opshub_app can read its own tables'
SET ROLE opshub_app;
SELECT count(*) IS NOT NULL AS readable FROM identity.employees;
SELECT count(*) IS NOT NULL AS readable FROM authz.user_role_assignments;
SELECT count(*) IS NOT NULL AS readable FROM audit.audit_logs;
SELECT count(*) IS NOT NULL AS readable FROM requests.request_items;
SELECT count(*) IS NOT NULL AS readable FROM storage.stored_files;

-- ── 3. …and cannot run DDL ───────────────────────────────────────────────────
DO $$
BEGIN
  BEGIN
    EXECUTE 'CREATE TABLE storage.fresh_db_ddl_probe (id int)';
    RAISE EXCEPTION 'opshub_app was able to CREATE TABLE — the role is not least-privilege';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE '  opshub_app cannot CREATE TABLE (expected)';
  END;

  BEGIN
    EXECUTE 'ALTER TABLE storage.stored_files ADD COLUMN fresh_db_ddl_probe int';
    RAISE EXCEPTION 'opshub_app was able to ALTER TABLE — the role is not least-privilege';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE '  opshub_app cannot ALTER TABLE (expected)';
  END;

  BEGIN
    EXECUTE 'CREATE SCHEMA fresh_db_ddl_probe';
    RAISE EXCEPTION 'opshub_app was able to CREATE SCHEMA — the role is not least-privilege';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE '  opshub_app cannot CREATE SCHEMA (expected)';
  END;
END $$;
RESET ROLE;

\echo '  opshub_worker cannot CREATE TABLE'
SET ROLE opshub_worker;
DO $$
BEGIN
  BEGIN
    EXECUTE 'CREATE TABLE storage.fresh_db_ddl_probe (id int)';
    RAISE EXCEPTION 'opshub_worker was able to CREATE TABLE — the role is not least-privilege';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE '  opshub_worker cannot CREATE TABLE (expected)';
  END;
END $$;
RESET ROLE;

-- ── 4. Default privileges: objects created AFTER the migrations are reachable ─
-- Created by `creator` with no GRANT of its own, so this passes only if 0043's
-- ALTER DEFAULT PRIVILEGES is in place for the grantor.
\echo '  a table AND a sequence created now by the migrator are reachable by the runtime roles'
SET ROLE :"creator";
DROP TABLE IF EXISTS storage.fresh_db_privilege_probe;
DROP SEQUENCE IF EXISTS storage.fresh_db_privilege_probe_seq;
CREATE TABLE storage.fresh_db_privilege_probe (id int);
CREATE SEQUENCE storage.fresh_db_privilege_probe_seq;
INSERT INTO storage.fresh_db_privilege_probe VALUES (1);
RESET ROLE;

-- One privilege per check, for the same reason section 1 says so: the comma-list
-- form answers "holds ANY of these" and would pass with one privilege missing.
-- Both object kinds, because 0043 grants four privileges on TABLES and two on
-- SEQUENCES, and a narrowed default privilege for either must fail here.
DO $$
DECLARE
  table_privileges CONSTANT text[] := ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'];
  sequence_privileges CONSTANT text[] := ARRAY['USAGE', 'SELECT'];
  r text;
  p text;
  creator text := (SELECT role::text FROM assert_creator);
BEGIN
  FOREACH r IN ARRAY ARRAY['opshub_app', 'opshub_worker'] LOOP
    FOREACH p IN ARRAY table_privileges LOOP
      IF NOT has_table_privilege(r, 'storage.fresh_db_privilege_probe', p) THEN
        RAISE EXCEPTION
          '% lacks % on storage.fresh_db_privilege_probe, a table created after the migrations: '
          'ALTER DEFAULT PRIVILEGES is missing or was set for the wrong grantor (creator = %)',
          r, p, creator;
      END IF;
    END LOOP;

    FOREACH p IN ARRAY sequence_privileges LOOP
      IF NOT has_sequence_privilege(r, 'storage.fresh_db_privilege_probe_seq', p) THEN
        RAISE EXCEPTION
          '% lacks % on storage.fresh_db_privilege_probe_seq, a sequence created after the migrations: '
          'ALTER DEFAULT PRIVILEGES is missing or was set for the wrong grantor (creator = %)',
          r, p, creator;
      END IF;
    END LOOP;
  END LOOP;
END $$;

-- …and each role exercises all four for real, so the checks above cannot be the
-- only thing standing between a partial default privilege and a pass.
\echo '  both runtime roles can read and write the table created after the migrations'
SET ROLE opshub_app;
SELECT count(*) AS rows_visible FROM storage.fresh_db_privilege_probe;
SELECT nextval('storage.fresh_db_privilege_probe_seq') IS NOT NULL AS sequence_usable;
INSERT INTO storage.fresh_db_privilege_probe VALUES (2);
DELETE FROM storage.fresh_db_privilege_probe WHERE id = 2;
INSERT INTO storage.fresh_db_privilege_probe VALUES (2);
UPDATE storage.fresh_db_privilege_probe SET id = 3 WHERE id = 2;
RESET ROLE;

SET ROLE opshub_worker;
SELECT count(*) AS rows_visible FROM storage.fresh_db_privilege_probe;
SELECT nextval('storage.fresh_db_privilege_probe_seq') IS NOT NULL AS sequence_usable;
INSERT INTO storage.fresh_db_privilege_probe VALUES (4);
DELETE FROM storage.fresh_db_privilege_probe WHERE id = 4;
INSERT INTO storage.fresh_db_privilege_probe VALUES (4);
UPDATE storage.fresh_db_privilege_probe SET id = 5 WHERE id = 4;
RESET ROLE;

SET ROLE :"creator";
DROP TABLE storage.fresh_db_privilege_probe;
DROP SEQUENCE storage.fresh_db_privilege_probe_seq;
RESET ROLE;

-- ── 5. Default privileges are recorded for the role that creates objects ─────
DO $$
DECLARE
  app_schemas text[] := (SELECT array_agg(schema_name) FROM assert_schemas);
  creator regrole := (SELECT role FROM assert_creator);
  schemas_present int;
  defaults_present int;
BEGIN
  schemas_present := cardinality(app_schemas);
  SELECT count(*) INTO defaults_present
    FROM pg_default_acl
   WHERE defaclrole = creator
     AND defaclnamespace::regnamespace::text = ANY(app_schemas)
     AND defaclobjtype IN ('r', 'S');
  IF defaults_present < schemas_present * 2 THEN
    RAISE EXCEPTION
      'expected ALTER DEFAULT PRIVILEGES for % in each of % schemas (2 rows each), found %',
      creator, schemas_present, defaults_present;
  END IF;
  RAISE NOTICE '  % default-privilege rows for % (expected %)', defaults_present, creator, schemas_present * 2;
END $$;

\echo '✅  runtime privileges: complete, usable, and DDL-free'
