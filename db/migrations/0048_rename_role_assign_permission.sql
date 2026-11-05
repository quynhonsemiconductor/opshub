-- Rename the permission `role.assign` to `group.assign`.
--
-- With the permission bundles now called groups (0047), the permission that puts an employee in one — and that
-- grants a permission to a single employee directly — is `group.assign`. The key `role.assign` is also about to
-- be reused: the `role.*` module is where job roles (today's positions) get their permissions.
--
-- THE KEY IS A PRIMARY KEY with no ON UPDATE CASCADE, so it cannot simply be updated. The new key is inserted
-- (copying the description), every grant that named the old one is pointed at the new one, and the old key is
-- deleted. A grant that already holds the new key is not duplicated.
--
-- Idempotent, and a no-op on a fresh database: there the permission catalogue is seeded AFTER the migrations,
-- so the old key does not exist yet.

INSERT INTO authz.permissions (key, description)
SELECT 'group.assign', description
  FROM authz.permissions
 WHERE key = 'role.assign'
ON CONFLICT (key) DO NOTHING;

UPDATE authz.group_permissions gp
   SET permission_key = 'group.assign'
 WHERE gp.permission_key = 'role.assign'
   AND NOT EXISTS (
     SELECT 1 FROM authz.group_permissions existing
      WHERE existing.group_id = gp.group_id AND existing.permission_key = 'group.assign'
   );
DELETE FROM authz.group_permissions WHERE permission_key = 'role.assign';

UPDATE authz.employee_permissions ep
   SET permission_key = 'group.assign'
 WHERE ep.permission_key = 'role.assign'
   AND NOT EXISTS (
     SELECT 1 FROM authz.employee_permissions existing
      WHERE existing.employee_id = ep.employee_id
        AND existing.permission_key = 'group.assign'
        AND existing.scope_type = ep.scope_type
        AND existing.scope_id IS NOT DISTINCT FROM ep.scope_id
   );
DELETE FROM authz.employee_permissions WHERE permission_key = 'role.assign';

DELETE FROM authz.permissions WHERE key = 'role.assign';
