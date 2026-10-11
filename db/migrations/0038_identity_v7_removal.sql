-- Remove identity 7's authentication tables.
--
-- opshub has NO users (dev only, never launched; owner, 2026-10-11), so this is a plain drop, in the
-- same migration set that creates the identity 8 tables: no expand/contract, no rollback window.
-- Deploys are migrate-before-flip, so the OLD api is briefly up without these tables; nobody uses it.
--
--   * identity.refresh_tokens: v7 refresh-token sessions. identity 8 sessions are rows in identity.session.
--   * identity.sso_identities: the Entra object id -> employee link. 0037 copied it to identity.account.
--
-- `employees.entra_oid` STAYS: the employee API and the Graph PIM code read it, and the onStaffSignIn hook
-- keeps it in step at every sign-in.

DROP TABLE IF EXISTS identity.refresh_tokens; -- expand-contract-ok: no users yet (owner, 2026-10-11)
--> statement-breakpoint
DROP TABLE IF EXISTS identity.sso_identities; -- expand-contract-ok: no users yet (owner, 2026-10-11)
