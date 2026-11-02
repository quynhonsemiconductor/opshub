-- Rename the permissions position.read and position.manage to role.read and role.manage.
--
-- Positions are now roles (0049), and the `role.*` module is free: the old `role.assign` was renamed to
-- `group.assign` in 0048 when the permission bundles became groups.
--
-- A permission key is a PRIMARY KEY with no ON UPDATE CASCADE, so for each key the new one is inserted
-- (copying the description), every grant that named the old one is pointed at the new one without duplicating
-- a grant that already holds it, and the old key is deleted — the same steps as 0048.
--
-- Idempotent, and a no-op on a fresh database, where the catalogue is seeded after the migrations.

DO $$
DECLARE
  renamed record;
BEGIN
  FOR renamed IN
    SELECT * FROM (VALUES ('position.read', 'role.read'), ('position.manage', 'role.manage')) AS keys (old_key, new_key)
  LOOP
    INSERT INTO authz.permissions (key, description)
    SELECT renamed.new_key, description FROM authz.permissions WHERE key = renamed.old_key
    ON CONFLICT (key) DO NOTHING;

    UPDATE authz.group_permissions gp
       SET permission_key = renamed.new_key
     WHERE gp.permission_key = renamed.old_key
       AND NOT EXISTS (
         SELECT 1 FROM authz.group_permissions existing
          WHERE existing.group_id = gp.group_id AND existing.permission_key = renamed.new_key
       );
    DELETE FROM authz.group_permissions WHERE permission_key = renamed.old_key;

    UPDATE authz.employee_permissions ep
       SET permission_key = renamed.new_key
     WHERE ep.permission_key = renamed.old_key
       AND NOT EXISTS (
         SELECT 1 FROM authz.employee_permissions existing
          WHERE existing.employee_id = ep.employee_id
            AND existing.permission_key = renamed.new_key
            AND existing.scope_type = ep.scope_type
            AND existing.scope_id IS NOT DISTINCT FROM ep.scope_id
       );
    DELETE FROM authz.employee_permissions WHERE permission_key = renamed.old_key;

    DELETE FROM authz.permissions WHERE key = renamed.old_key;
  END LOOP;
END $$;
