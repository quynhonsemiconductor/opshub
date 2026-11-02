-- ============================================================================
-- Migration 0012: least-privilege database roles
-- ============================================================================
-- Today the API, the worker AND the migrator all connect with the RDS master
-- credential. That single credential OWNS every object in the database, so an
-- ordinary read request runs with rights to DROP the schema it is reading.
--
-- The consequence that matters most is not the dramatic one. A table's owner is
-- exempt from row-level security unless FORCE ROW LEVEL SECURITY is also set, so
-- any RLS policy added later would be silently bypassed by every request — the
-- policy would exist, be reviewable, and do nothing. Moving the runtime off the
-- owner is what makes that layer possible at all.
--
-- This migration creates the roles and the grants. It deliberately does NOT
-- switch anything over:
--
--   * The roles are created NOLOGIN. They cannot connect, cannot be used, and
--     cannot lock anyone out. Applying this migration changes the behaviour of
--     exactly nothing that is running.
--   * Cutover — generating passwords, storing them in Secrets Manager, pointing
--     DATABASE_USER/PASSWORD at the app secret, and granting LOGIN — is a
--     separate, separately reviewed step. See
--     docs/runbooks/db-role-least-privilege.md.
--
-- `db/migrate.ts` already prefers DATABASE_MIGRATION_URL over DATABASE_URL, and
-- `db/database-url.ts` already composes a DSN from discrete parts, so the
-- application side needs no code change — only the credentials it is handed.
--
-- Idempotent: safe to re-run, and safe on a database where the roles already
-- exist (e.g. a developer who created them by hand from the runbook).
-- ============================================================================

DO $$
DECLARE
  -- Every schema the application reads or writes. Listed explicitly rather than
  -- discovered from the catalogue: a new schema nobody adds here leaves the app
  -- unable to reach it, which fails loudly at cutover, where auto-discovery would
  -- silently grant on whatever happened to exist.
  app_schemas CONSTANT text[] := ARRAY[
    'identity', 'authz', 'access', 'assets', 'audit', 'catalog', 'compliance',
    'licenses', 'messaging', 'notifications', 'requests', 'security_posture',
    'storage', 'workforce'
  ];
  s text;
BEGIN
  -- ── Roles ─────────────────────────────────────────────────────────────────
  -- NOLOGIN until the cutover grants LOGIN with a password from Secrets Manager.

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opshub_app') THEN
    CREATE ROLE opshub_app NOLOGIN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opshub_worker') THEN
    CREATE ROLE opshub_worker NOLOGIN;
  END IF;

  -- The migrator keeps DDL rights. It is the role that should own the schemas
  -- once ownership is transferred at cutover; until then the master role still
  -- owns everything and this role is simply unused.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opshub_migrate') THEN
    CREATE ROLE opshub_migrate NOLOGIN;
  END IF;

  -- ── Grants ────────────────────────────────────────────────────────────────
  -- DML only for the runtime roles: no CREATE, no DROP, no TRUNCATE, and
  -- crucially no ownership — so a future FORCE ROW LEVEL SECURITY applies to them
  -- rather than being silently skipped.

  FOREACH s IN ARRAY app_schemas LOOP
    -- Tolerate a schema that does not exist yet: this migration runs against
    -- developer databases at various ages, and aborting the whole DO block over a
    -- schema a later migration creates would break the deploy.
    IF NOT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = s) THEN
      CONTINUE;
    END IF;

    EXECUTE format('GRANT USAGE ON SCHEMA %I TO opshub_app, opshub_worker, opshub_migrate', s);
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO opshub_app, opshub_worker',
      s
    );
    EXECUTE format(
      'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO opshub_app, opshub_worker', s
    );
    EXECUTE format('GRANT ALL ON SCHEMA %I TO opshub_migrate', s);
    EXECUTE format('GRANT ALL ON ALL TABLES IN SCHEMA %I TO opshub_migrate', s);
    EXECUTE format('GRANT ALL ON ALL SEQUENCES IN SCHEMA %I TO opshub_migrate', s);

    -- Tables created LATER must be reachable too, or the first migration after this
    -- one silently leaves the app unable to read its own new table.
    --
    -- Default privileges are per GRANTOR, and the grantor here is the role running
    -- this migration — the RDS master user, which still owns every object until
    -- cutover. So these two cover everything the migrator creates today.
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA %I '
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO opshub_app, opshub_worker', s
    );
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA %I '
      'GRANT USAGE, SELECT ON SEQUENCES TO opshub_app, opshub_worker', s
    );

    -- The equivalent `... FOR ROLE opshub_migrate ...` pair belongs to the CUTOVER
    -- migration, not here. Postgres only lets you set another role's default
    -- privileges if you hold ADMIN OPTION on it, and whether the master user does
    -- depends on who created opshub_migrate — the creator gets it implicitly. rova
    -- learned this the hard way: the statement's success varied by environment and
    -- a "permission denied to change default privileges" aborted the whole
    -- migration, breaking the develop deploy.
    --
    -- It also buys nothing yet: opshub_migrate is NOLOGIN and creates no objects
    -- until cutover, so it has no default privileges to apply. Set them in the
    -- migration that transfers ownership, which necessarily runs as (or as a member
    -- of) opshub_migrate and can do it without any membership gymnastics.
  END LOOP;

  -- Drizzle's own bookkeeping table; only the migrator needs it.
  IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'drizzle') THEN
    EXECUTE 'GRANT ALL ON SCHEMA drizzle TO opshub_migrate';
    EXECUTE 'GRANT ALL ON ALL TABLES IN SCHEMA drizzle TO opshub_migrate';
  END IF;
END $$;

-- ── Per-role statement timeouts ─────────────────────────────────────────────
-- Nothing currently bounds how long a query may run. `drizzle.provider.ts` sets a
-- connection-acquisition timeout, which is how long a caller WAITS for a pool
-- slot — not how long a query may hold one. So a single pathological query pins
-- its connection indefinitely, and the symptom is not "slow query": it is every
-- OTHER request queueing and then erroring, with nothing pointing at the query
-- responsible.
--
-- Set on the ROLE rather than in the parameter group deliberately. A cluster-wide
-- statement_timeout would also apply to opshub_migrate, and DDL on a large table
-- legitimately runs for minutes — a migration killed halfway is a far worse
-- failure than a slow request. Per-role settings are applied at connection time,
-- so the migrator keeps no limit while the two runtime roles get one.
--
-- Inert until cutover rather than wrong: where a service still connects as the RDS
-- master, none of these roles is the one connecting.
--
-- Idempotent: ALTER ROLE … SET overwrites.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opshub_app') THEN
    -- A ceiling, not a target. Every real request query here is single-digit
    -- milliseconds, so anything approaching this is a bug; the value sits far
    -- outside normal variance rather than trimming the tail.
    ALTER ROLE opshub_app SET statement_timeout = '30s';
    -- An open transaction holds its row locks, pins the connection, and blocks
    -- VACUUM from reclaiming anything newer than it. 60s is generous for a
    -- request-scoped transaction and still bounds a leaked one.
    ALTER ROLE opshub_app SET idle_in_transaction_session_timeout = '60s';
  END IF;

  -- The background path gets a longer ceiling: the outbox relay and the scheduled
  -- sweeps legitimately run longer than any request.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opshub_worker') THEN
    ALTER ROLE opshub_worker SET statement_timeout = '120s';
    ALTER ROLE opshub_worker SET idle_in_transaction_session_timeout = '180s';
  END IF;
END $$;
