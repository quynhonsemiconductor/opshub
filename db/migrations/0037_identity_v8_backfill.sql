-- Employees -> identity users, with their ids; Entra identities -> Microsoft accounts.
--
-- Seed and dev data only: opshub has no users, so this needs no zero-downtime care (no batching, no dual
-- writes). It exists so the seeded employees and any dev rows keep their ids: `identity.user.id` IS
-- `identity.employees.id`, and every foreign key to an employee in this codebase keeps meaning the same
-- person. It must run BEFORE 0038, which drops the table it reads.
--
-- Employees created before their first Entra sign-in have no sso_identities row: they get a user and no
-- account, and the first Microsoft sign-in links the account to that user by email (a tenant member comes
-- with a verified address), so the id is preserved.
--
-- Precondition (asserted by the migration job): no two employees collide once lower-cased.
-- gen_random_uuid(), not uuidv7(): PostgreSQL 16 (on-prem) and 17 (dev, CI) have no uuidv7().

INSERT INTO identity."user" (id, name, email, email_verified, banned, ban_reason, created_at, updated_at)
SELECT e.id,
       e.display_name,
       lower(e.email),
       true,
       e.status = 'offboarded',
       CASE WHEN e.status = 'offboarded' THEN 'migrated from v7: offboarded' END,
       e.created_at,
       now()
FROM identity.employees e
ON CONFLICT (id) DO NOTHING;
--> statement-breakpoint
INSERT INTO identity.account (id, account_id, provider_id, user_id, created_at, updated_at)
SELECT gen_random_uuid(), s.provider_sub, 'microsoft', s.user_id, s.created_at, now()
FROM identity.sso_identities s
JOIN identity."user" u ON u.id = s.user_id
WHERE s.provider = 'entra'
  AND NOT EXISTS (
    SELECT 1 FROM identity.account a
    WHERE a.provider_id = 'microsoft' AND a.account_id = s.provider_sub
  );
--> statement-breakpoint
-- Employees whose Entra object id lives only on the employee row (set by an earlier v7 login path)
INSERT INTO identity.account (id, account_id, provider_id, user_id, created_at, updated_at)
SELECT gen_random_uuid(), e.entra_oid, 'microsoft', e.id, e.created_at, now()
FROM identity.employees e
JOIN identity."user" u ON u.id = e.id
WHERE e.entra_oid IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM identity.account a
    WHERE a.provider_id = 'microsoft' AND a.account_id = e.entra_oid
  );
