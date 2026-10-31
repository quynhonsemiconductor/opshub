-- The FRESH half of the fresh-DB rebuild gate, provisioned the way the platform
-- provisions it on-prem: CNPG creates the roles and the database owner BEFORE any
-- migration runs, and the migrator holds no CREATEROLE. Run as a superuser (CI's
-- `postgres`), once per cluster.
--
--   opshub_fresh — "rebuild from zero": roles exist, no objects, migrator cannot
--                  create roles. Every migration must apply as opshub_migrator.
--
-- The legacy half runs on its OWN cluster (roles are cluster-wide, so a database
-- whose legacy `opshub_migrate` fixture must not share one with these roles): the
-- workflow creates `opshub_legacy` there itself, owned by the superuser, and
-- leaves the roles to `legacy-0012.sql`.
--
-- Passwords are test-only literals, same convention as the CI `postgres`
-- superuser the other jobs already connect with.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opshub_migrator') THEN
    CREATE ROLE opshub_migrator LOGIN PASSWORD 'opshub_migrator' NOCREATEROLE NOCREATEDB;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opshub_app') THEN
    CREATE ROLE opshub_app LOGIN PASSWORD 'opshub_app';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opshub_worker') THEN
    CREATE ROLE opshub_worker LOGIN PASSWORD 'opshub_worker';
  END IF;
END $$;

SELECT 'CREATE DATABASE opshub_fresh OWNER opshub_migrator'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'opshub_fresh')
\gexec
