-- Rename the authorization "roles" to groups.
--
-- `authz.roles` has always been a named set of permissions, not a job role: `admin`, `hr`, `manager` are
-- bundles that people are put into. "Role" is the word the product now uses for a job (the `positions` table,
-- renamed in a later migration), so the permission bundles take the name they describe — groups.
--
--   authz.roles                  → authz.groups
--   authz.role_permissions       → authz.group_permissions          (role_id → group_id)
--   authz.user_role_assignments  → authz.employee_groups            (user_id → employee_id, role_id → group_id)
--   identity.employees.roles     → identity.employees.group_keys    (the cache of a person's group keys)
--
-- A RENAME KEEPS EVERY ROW, INDEX AND FOREIGN KEY: nothing is copied and nothing is rewritten, so the rows and
-- the grants on the tables stay as they were. The auto-named primary-key and foreign-key constraints and the
-- hand-named indexes are renamed too, so a database built from these migrations reads the same as one built
-- from the schema file.
--
-- Group KEYS (`admin`, `hr`, …) are untouched, which is what lets Entra App Roles keep mapping to them.
--
-- Idempotent: each block runs only while the old name still exists.

DO $$
BEGIN
  IF to_regclass('authz.roles') IS NOT NULL THEN
    ALTER TABLE authz.roles RENAME TO groups;
    ALTER TABLE authz.groups RENAME CONSTRAINT roles_pkey TO groups_pkey;
    ALTER INDEX authz.uq_role_key RENAME TO uq_group_key;
  END IF;

  IF to_regclass('authz.role_permissions') IS NOT NULL THEN
    ALTER TABLE authz.role_permissions RENAME TO group_permissions;
    ALTER TABLE authz.group_permissions RENAME COLUMN role_id TO group_id;
    ALTER TABLE authz.group_permissions
      RENAME CONSTRAINT role_permissions_role_id_permission_key_pk TO group_permissions_group_id_permission_key_pk;
    ALTER TABLE authz.group_permissions
      RENAME CONSTRAINT role_permissions_permission_key_permissions_key_fk TO group_permissions_permission_key_permissions_key_fk;
    ALTER TABLE authz.group_permissions
      RENAME CONSTRAINT role_permissions_role_id_roles_id_fk TO group_permissions_group_id_groups_id_fk;
  END IF;

  IF to_regclass('authz.user_role_assignments') IS NOT NULL THEN
    ALTER TABLE authz.user_role_assignments RENAME TO employee_groups;
    ALTER TABLE authz.employee_groups RENAME COLUMN user_id TO employee_id;
    ALTER TABLE authz.employee_groups RENAME COLUMN role_id TO group_id;
    ALTER TABLE authz.employee_groups RENAME CONSTRAINT user_role_assignments_pkey TO employee_groups_pkey;
    ALTER TABLE authz.employee_groups
      RENAME CONSTRAINT user_role_assignments_role_id_roles_id_fk TO employee_groups_group_id_groups_id_fk;
    ALTER INDEX authz.ix_ura_user RENAME TO ix_employee_group_employee;
    ALTER INDEX authz.uq_ura_user_role_global RENAME TO uq_employee_group_global;
    ALTER INDEX authz.uq_ura_user_role_scoped RENAME TO uq_employee_group_scoped;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'identity' AND table_name = 'employees' AND column_name = 'roles'
  ) THEN
    ALTER TABLE identity.employees RENAME COLUMN roles TO group_keys;
  END IF;
END $$;
