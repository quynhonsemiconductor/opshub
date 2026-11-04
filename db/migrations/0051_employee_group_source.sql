-- Who put an employee in a group: a person, or the identity provider's sign-in sync.
--
-- `StaffSignInHandler` reconciles the App Roles of the id_token into global group memberships at EVERY sign-in
-- and revokes any global membership the token does not name. That is right for what the identity provider
-- granted, and wrong for what a person granted by hand (the general `approver` group is meant to be handed out
-- in the UI): the hand-made membership disappeared at the person's next sign-in. `source` tells the two apart:
-- the sync now revokes only `idp` rows.
--
-- Existing rows: the sync wrote its rows with `granted_by = employee_id` (it acts as the person signing in),
-- so those become `idp` and keep behaving as before; every other row was granted by somebody else and
-- becomes `manual`. A person who put THEMSELVES in a group was already revoked at their next sign-in, so
-- reading that row as `idp` keeps what happened before.
--
-- Additive and idempotent: the backfill runs only in the migration that adds the column.

DO $$
BEGIN
  CREATE TYPE membership_source AS ENUM ('manual', 'idp');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'authz' AND table_name = 'employee_groups' AND column_name = 'source'
  ) THEN
    ALTER TABLE authz.employee_groups
      ADD COLUMN source membership_source NOT NULL DEFAULT 'manual';
    UPDATE authz.employee_groups SET source = 'idp' WHERE granted_by = employee_id;
  END IF;
END
$$;
