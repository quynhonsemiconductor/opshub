-- Employee permissions: a permission granted to ONE employee directly, outside any group.
--
-- Group membership (`authz.user_role_assignments` today) is how almost everyone gets permissions. This table is
-- the exception path: a single extra permission that does not justify a group of its own. It carries what the
-- membership table carries — a scope, an optional expiry, who granted it — plus a mandatory `reason`, because
-- a grant that bypasses the groups has to say why it exists.
--
-- Same pair of partial unique indexes as `user_role_assignments`: Postgres treats NULL scope_id as distinct, so
-- global grants (scope_id IS NULL) and scoped grants need one index each.
--
-- Additive and idempotent. The runtime roles reach the table through the default privileges migration 0043
-- re-stated for this schema.

CREATE TABLE IF NOT EXISTS authz.employee_permissions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id    uuid NOT NULL,
  permission_key varchar(120) NOT NULL REFERENCES authz.permissions (key) ON DELETE CASCADE,
  scope_type     scope_type NOT NULL DEFAULT 'global',
  scope_id       varchar(120),
  granted_by     uuid NOT NULL,
  reason         text NOT NULL,
  expires_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_employee_permission_global
  ON authz.employee_permissions (employee_id, permission_key, scope_type)
  WHERE scope_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_employee_permission_scoped
  ON authz.employee_permissions (employee_id, permission_key, scope_type, scope_id)
  WHERE scope_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_employee_permission_employee
  ON authz.employee_permissions (employee_id);
