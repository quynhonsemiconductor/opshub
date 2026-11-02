-- Rename positions to roles.
--
-- A position has always been the ROLE as an entity — "QA Engineer, approved headcount 2" — that outlives
-- whoever occupies it (see 0016). The product now calls it a role, and the permission bundles that used to
-- take the name are groups (0047), so the word is free.
--
--   schema positions                         → roles
--   positions.positions                      → roles.roles
--   positions.employee_positions             → roles.employee_roles       (position_id → role_id)
--   training.position_requirements           → training.role_requirements (position_id → role_id)
--   contracts.employment_contracts.position_id → role_id
--   performance.reviews.position_id            → role_id
--   type position_status                     → role_status
--
-- A RENAME KEEPS EVERY ROW, INDEX AND FOREIGN KEY, and the grants and default privileges that 0043 set on the
-- schema follow it, since they are attached to the schema's identity and not to its name. The hand-named
-- indexes and checks and the auto-named key constraints are renamed with the objects, so a database built from
-- these migrations reads the same as one built from the schema file. PostgreSQL's NOT NULL constraints keep
-- the old table name in theirs: they are internal and nothing refers to them.
--
-- Idempotent: the block runs only while the old schema still exists.

DO $$
BEGIN
  IF to_regnamespace('positions') IS NOT NULL THEN
    ALTER SCHEMA positions RENAME TO roles;

    ALTER TABLE roles.positions RENAME TO roles;
    ALTER TABLE roles.roles RENAME CONSTRAINT positions_pkey TO roles_pkey;
    ALTER TABLE roles.roles RENAME CONSTRAINT positions_rank_id_fkey TO roles_rank_id_fkey;
    ALTER TABLE roles.roles RENAME CONSTRAINT ck_position_headcount_positive TO ck_role_headcount_positive;
    ALTER INDEX roles.uq_position_code RENAME TO uq_role_code;
    ALTER INDEX roles.ix_position_department RENAME TO ix_role_department;
    ALTER INDEX roles.ix_position_status RENAME TO ix_role_status;
    ALTER INDEX roles.ix_position_rank RENAME TO ix_role_rank;

    ALTER TABLE roles.employee_positions RENAME TO employee_roles;
    ALTER TABLE roles.employee_roles RENAME COLUMN position_id TO role_id;
    ALTER TABLE roles.employee_roles RENAME CONSTRAINT employee_positions_pkey TO employee_roles_pkey;
    ALTER TABLE roles.employee_roles
      RENAME CONSTRAINT employee_positions_position_id_fkey TO employee_roles_role_id_fkey;
    ALTER TABLE roles.employee_roles RENAME CONSTRAINT ck_employee_position_window TO ck_employee_role_window;
    ALTER INDEX roles.uq_employee_current_position RENAME TO uq_employee_current_role;
    ALTER INDEX roles.ix_employee_position_employee RENAME TO ix_employee_role_employee;
    ALTER INDEX roles.ix_employee_position_position RENAME TO ix_employee_role_role;

    ALTER TYPE public.position_status RENAME TO role_status;

    ALTER TABLE contracts.employment_contracts RENAME COLUMN position_id TO role_id;
    ALTER TABLE contracts.employment_contracts
      RENAME CONSTRAINT employment_contracts_position_id_fkey TO employment_contracts_role_id_fkey;
    ALTER INDEX contracts.ix_contract_position RENAME TO ix_contract_role;

    ALTER TABLE performance.reviews RENAME COLUMN position_id TO role_id;
    ALTER TABLE performance.reviews RENAME CONSTRAINT reviews_position_id_fkey TO reviews_role_id_fkey;

    ALTER TABLE training.position_requirements RENAME TO role_requirements;
    ALTER TABLE training.role_requirements RENAME COLUMN position_id TO role_id;
    ALTER TABLE training.role_requirements RENAME CONSTRAINT position_requirements_pkey TO role_requirements_pkey;
    ALTER TABLE training.role_requirements
      RENAME CONSTRAINT position_requirements_course_id_fkey TO role_requirements_course_id_fkey;
    ALTER TABLE training.role_requirements
      RENAME CONSTRAINT position_requirements_position_id_fkey TO role_requirements_role_id_fkey;
    ALTER INDEX training.ix_training_requirement_position RENAME TO ix_training_requirement_role;
  END IF;
END $$;
