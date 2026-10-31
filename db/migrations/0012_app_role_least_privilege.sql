-- ============================================================================
-- Migration 0012: least-privilege database roles — grants only
-- ============================================================================
-- History: the API, the worker AND the migrator used to connect with the RDS
-- master credential, which owns every object in the database — so an ordinary
-- read request ran with rights to DROP the schema it was reading, and any
-- row-level policy would silently exempt the owner. This migration created
-- `opshub_app`, `opshub_worker` and the legacy `opshub_migrate`, granted DML to
-- the first two, and set per-role statement timeouts. Cutover (LOGIN +
-- passwords) stayed a separate, reviewed step; see
-- docs/runbooks/db-role-least-privilege.md.
--
-- 2026-10-31 — on-prem rebuild-from-zero gate. CNPG now creates the roles
-- (`opshub_app`, `opshub_worker`, `opshub_migrator`; passwords from Key Vault)
-- and `opshub_migrator` deliberately has NO CREATEROLE. A migration that runs
-- `CREATE ROLE` therefore aborts the very first migration on a fresh on-prem
-- database, and — even where it succeeded — it granted and altered the legacy
-- `opshub_migrate`, which on-prem does not exist. The roles are the platform's
-- job; what is left here is the grant half, and it targets the roles that are
-- actually present.
--
-- Role CREATION survives only as a GUARDED convenience for databases with no
-- CNPG in front of them (CI, a developer's own Postgres), which run migrations
-- as a SUPERUSER and expect `db:roles:enable` to find the roles afterwards. It
-- is skipped whenever the connecting role lacks CREATEROLE, which is exactly
-- the on-prem case, and it also creates the legacy `opshub_migrate` there
-- because later migrations in this journal still name it.
--
-- The statement timeouts are NO LONGER SET HERE: granting a role its limits is
-- the platform's job on-prem (a NOCREATEROLE migrator cannot `ALTER ROLE`
-- another role), so they live in the CNPG role configuration — the values are
-- recorded in docs/runbooks/db-role-least-privilege.md and in migration 0043's
-- header. Databases that ran the old text keep the settings, because
-- `ALTER ROLE … SET` is persisted in pg_db_role_setting and nothing here resets
-- it.
--
-- Idempotent: safe to re-run, and safe on a database where the roles already
-- exist.
--
-- EDITED IN PLACE on 2026-10-31, deliberately. Drizzle compares only the
-- journal's `when` against `__drizzle_migrations` (`drizzle-orm` 0.45.4,
-- pg-core/dialect.js:57 and :62) and never the recorded hash, so this file does
-- not re-run where it already has; the only trace is a hash the database
-- recorded that the file no longer has (recorded: 9660369c34e2c7a818377ab5b3bd…,
-- sha256 of the old text). Every environment that ran the old 0012 keeps its
-- grants, and 0043 re-states the full set, so a fresh database and an upgraded
-- one converge on the same end state rather than on this entry.
-- ============================================================================

DO $$
DECLARE
  -- Every schema the application reads or writes. Listed explicitly rather than
  -- discovered from the catalogue: a new schema nobody adds here leaves the app
  -- unable to reach it, which fails loudly at cutover, where auto-discovery would
  -- silently grant on whatever happened to exist. (0043 derives the list from
  -- schema ownership instead, so a schema added after 0012 is still covered.)
  app_schemas CONSTANT text[] := ARRAY[
    'identity', 'authz', 'access', 'assets', 'audit', 'catalog', 'compliance',
    'licenses', 'messaging', 'notifications', 'requests', 'security_posture',
    'storage', 'workforce'
  ];
  runtime_roles CONSTANT text[] := ARRAY['opshub_app', 'opshub_worker'];
  migrator_roles CONSTANT text[] := ARRAY['opshub_migrator', 'opshub_migrate'];
  may_create_role boolean := (
    SELECT rolsuper OR rolcreaterole FROM pg_roles WHERE rolname = current_user
  );
  present_roles text[] := ARRAY[]::text[];
  present_migrators text[] := ARRAY[]::text[];
  role_list text;
  migrator_list text;
  s text;
  r text;
BEGIN
  -- ── Roles: platform-owned, creation only as a guarded convenience ─────────
  FOREACH r IN ARRAY runtime_roles LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) AND may_create_role THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN', r);
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      present_roles := present_roles || r;
    END IF;
  END LOOP;

  -- The legacy migrator name only where this journal's later grants still need
  -- it, and only where the connecting role may create roles at all.
  IF may_create_role AND NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opshub_migrate') THEN
    CREATE ROLE opshub_migrate NOLOGIN;
  END IF;

  FOREACH r IN ARRAY migrator_roles LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      present_migrators := present_migrators || r;
    END IF;
  END LOOP;

  -- A database with neither runtime role is one the platform has not
  -- provisioned. Fail with the reason rather than applying nothing and leaving
  -- the app unable to read its own tables.
  IF cardinality(present_roles) = 0 THEN
    RAISE EXCEPTION
      'Migration 0012 found none of the runtime roles % and the connecting role % cannot create them. '
      'They are provisioned by the platform (CNPG managed roles on-prem, docs/runbooks/db-role-least-privilege.md on AWS).',
      runtime_roles, current_user;
  END IF;

  role_list := array_to_string(ARRAY(SELECT quote_ident(u) FROM unnest(present_roles) AS u), ', ');
  migrator_list := array_to_string(
    ARRAY(SELECT quote_ident(u) FROM unnest(present_migrators) AS u), ', '
  );

  -- ── Grants ────────────────────────────────────────────────────────────────
  -- DML only for the runtime roles: no CREATE, no DROP, no TRUNCATE, and
  -- crucially no ownership — so a future FORCE ROW LEVEL SECURITY would apply
  -- to them rather than being silently skipped.

  FOREACH s IN ARRAY app_schemas LOOP
    -- Tolerate a schema that does not exist yet: this migration runs against
    -- developer databases at various ages, and aborting the whole DO block over a
    -- schema a later migration creates would break the deploy.
    IF NOT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = s) THEN
      CONTINUE;
    END IF;

    EXECUTE format('GRANT USAGE ON SCHEMA %I TO %s', s, role_list);
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO %s', s, role_list
    );
    EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO %s', s, role_list);

    -- The migrator owns what it creates on-prem, so it needs no grants there;
    -- where a legacy migrator role exists (AWS-era databases, CI), it keeps the
    -- ALL it had.
    IF cardinality(present_migrators) > 0 THEN
      EXECUTE format('GRANT ALL ON SCHEMA %I TO %s', s, migrator_list);
      EXECUTE format('GRANT ALL ON ALL TABLES IN SCHEMA %I TO %s', s, migrator_list);
      EXECUTE format('GRANT ALL ON ALL SEQUENCES IN SCHEMA %I TO %s', s, migrator_list);
    END IF;

    -- Tables created LATER must be reachable too, or the first migration after this
    -- one silently leaves the app unable to read its own new table.
    --
    -- Default privileges are per GRANTOR, and the grantor is the role running this
    -- migration: the RDS master on the AWS-era shape, `opshub_migrator` on-prem —
    -- the creator of every future table on either path, so `FOR ROLE` is
    -- unnecessary and naming a role here would fail on the other path.
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA %I '
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %s', s, role_list
    );
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT USAGE, SELECT ON SEQUENCES TO %s', s, role_list
    );
  END LOOP;

  -- Drizzle's own bookkeeping table; only the migrator needs it, and on-prem that
  -- is the role running this migration (the owner).
  IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'drizzle')
     AND cardinality(present_migrators) > 0 THEN
    EXECUTE format('GRANT ALL ON SCHEMA drizzle TO %s', migrator_list);
    EXECUTE format('GRANT ALL ON ALL TABLES IN SCHEMA drizzle TO %s', migrator_list);
  END IF;
END $$;
