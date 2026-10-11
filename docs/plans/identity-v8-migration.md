# Plan: migrate opshub from `@quynhonsemiconductor/identity` ^7.1 to 8.0.1

**Status:** PHASE 1, plan only. No code in this PR. Nothing here is merged or deployed by the PR that carries it.
**Target:** identity `8.0.1` (Better Auth), `staff` preset only, Microsoft Entra sign-in, single tenant, `allowGuests: false`.
**Sources read:** app-platform `packages/identity/MIGRATION-v7-to-v8.md`, the identity README (as of `main`, which includes the
staff-cap, transaction and error-envelope fixes), ADR 0002, contract §4 and §7; opshub's auth as of `9735aec`.

This document is written against what the code does today, not against the generic migration guide. Where the two disagree
the difference is called out, because several of them change the shape of the work.

---

## 0. Read this first

### 0.1 What the generic guide gets wrong for opshub

| Generic guide says | opshub reality | Consequence |
| --- | --- | --- |
| Copy `identity.users` into `user` | opshub has **no `identity.users`**. The user table **is `identity.employees`**, and `employees.id` is the actor id in every module (audit, authz assignments, requests, approvals, ~40 FKs) | `user.id` must equal `employees.id`. Copy **employees**, and keep the two in step afterwards (§2.3) |
| Redirect URI `https://<api>/api/auth/callback/microsoft` | opshub is **same-origin by design**: the SPA host proxies `/v1/*` to the API through a Cloudflare Pages Function, because the session cookie must be set on the SPA host. v7's redirect URI is already the SPA host (`https://opshub-dev.qnsc.vn/v1/bff/callback`) | The v8 redirect URI is `https://<opshub-SPA-host>/api/auth/callback/microsoft`, and the Pages Function must also proxy `/api/auth/*`. **A redirect URI on the API host would set the cookie on a host the SPA never sends it to** (§5) |
| "Claims: nothing, look permissions up per request" | True for permissions (opshub's `PolicyGuard` already resolves from the database). **But opshub also syncs Entra App Roles into its role assignments on every login** | identity 8.0.1's `staff` preset **does not hand the product the Entra `roles` claim** (§3.2). This is a blocker that needs an app-platform change |
| Frontend: use `better-auth/react` | opshub's SPA calls `/v1/auth/me` with a plain `fetch` and has no auth library; the login is one button | Two plain fetches are enough; no new SPA dependency is needed (§1.6) |
| `IdentityModule` is imported by the app | In opshub `ContractsModule` and `TrainingModule` import the **opshub** `IdentityModule` for `EmployeeService`, and the **worker** compiles both | The worker would load identity's Fastify mount and crash. The module has to be split (§1.2) |

### 0.2 Three things that must exist before the cutover (blockers)

1. **A hook that delivers the Entra `roles` claim.** `createIdentity` has `hooks.onUserCreated` (creation only) and
   `onSsoProvisioned`/`ssoRole` (the `organizations` preset, not Microsoft staff sign-in). The Microsoft provider keeps the id_token
   claims only inside its own `getUserInfo`. Nothing reaches opshub. Proposal in §3.2: a `hooks.onStaffSignIn(user, { roles, oid, … })` in app-platform.
2. **Service-side user lifecycle: ban and revoke a user's sessions without an admin session.** Offboarding must end the employee's
   sessions at once (today: `refreshTokenRepo.revokeAllForEmployee` + `authCache.revokeUser`, pinned by `offboarding-revocation` and
   `fast-revocation` e2e specs). identity exports `revokeAllSessions(auth)` (everyone) but nothing per user; `auth.api.revokeUserSessions`
   and `banUser` are admin endpoints that need an admin **session**. Proposal in §3.3: `revokeUserSessions(auth, userId)` and
   `setUserBanned(auth, userId, banned)` next to `revokeAllSessions`.
3. **`mail` is a required option** of `createIdentity` although the `staff` preset sends no mail. Workaround without a package change:
   a stub that throws (§1.3). Nicer: make `mail` optional for a staff-only instance.

Items 1 and 2 are small app-platform PRs (one PR each, with kit tests). Until they are released the opshub cutover PR cannot
be completed; the expand-only migration PR (§7, step 1) can land first.

### 0.3 Product-visible changes to confirm (details in §8)

- **Every user signs in again once** (old sessions are not migrated; §2.4).
- **Sessions last 12 hours, not 30 days.** The staff preset caps every session at 12 h and has no sliding refresh. Users re-authenticate
  daily (Entra's own session usually makes that a no-prompt redirect).
- **`SameSite=Lax`** on the session cookie (Better Auth) instead of `Strict`, and the cookie is `__Secure-opshub.session_token`
  instead of `__Host-opshub_session`.

---

## 1. Files and modules

Paths are relative to the repo root. "R" removed, "M" modified, "A" added.

### 1.1 Dependencies (`package.json`, `pnpm-lock.yaml`)

| | Change |
| --- | --- |
| M | `@quynhonsemiconductor/identity` `^7.1.0` → `8.0.1` (exact until the cutover is verified; Renovate never auto-merges this major) |
| A | `@quynhonsemiconductor/platform-db` `>=0.1.1` (identity peer; opshub keeps its own Drizzle instance, the package is needed for types/peer resolution only. Open question Q9) |
| M | `@quynhonsemiconductor/platform-http` `^4.0.0` → `^4.2.0` (`enableCorrelationId`), `observability` `^0.2.0` → `^0.2.2`, `platform-cache` `^3.1.0` → `^3.1.1` |
| R | `@nestjs/jwt`, `@nestjs/passport`, `passport`, `passport-jwt`, `@types/passport-jwt` (nothing else uses them: verified by grep). `jose` is checked after the removal |
| — | **No `better-auth` dependency**: "products never import it". A lint rule forbids it (identity plan I7) |

pnpm 10 is pinned in CI (`PNPM_VERSION: 10.33.2`) and `.npmrc` carries the token line, so the pnpm-11 registry-auth change in the
migration guide does not apply yet. It will when opshub moves to pnpm 11: three places (dev machines, Actions, Dockerfile).

### 1.2 `libs/modules/identity` (the module is split in two)

Today one `IdentityModule` owns the employee directory **and** authentication, and it is imported by `ContractsModule` and
`TrainingModule` (hence by the worker). The split:

| | Path | What |
| --- | --- | --- |
| A | `libs/modules/identity/src/employees.module.ts` | `EmployeesModule`: `EmployeeService`, `EmployeeDrizzleRepository`, `EmployeesController`. No auth. Imported by contracts, training and the API |
| A | `libs/modules/identity/src/auth.module.ts` | `AuthModule` (**API only**): `IdentityModule.forRootAsync({ useFactory: createOpshubIdentity })`, the principal guard, `AuthController` (`/v1/auth/me`), the security-event→audit bridge |
| A | `libs/modules/identity/src/infrastructure/auth/create-opshub-identity.ts` | The single `createIdentity()` call (§1.3). The only file that may import identity's factory |
| A | `libs/modules/identity/src/infrastructure/auth/staff-sign-in.hook.ts` | `onStaffSignIn` handler: role sync + employee JIT (§3) |
| A | `libs/modules/identity/src/infrastructure/auth/user-directory.ts` | Keeps `identity."user"` in step with `employees` (§2.3) |
| A | `libs/modules/identity/src/infrastructure/auth/security-events.audit.ts` | `SecurityEventSink` → `AuditService` (§1.5) |
| M | `libs/modules/identity/src/application/employee.service.ts` | `updateStatus('offboarded')` calls `revokeUserSessions` + `setUserBanned(true)` instead of `refreshTokenRepo.revokeAllForEmployee` + `authCache.revokeUser`; `'active'` calls `setUserBanned(false)`. `create` writes the matching `user` row in the **same transaction** |
| M | `libs/modules/identity/src/interface/http/auth.controller.ts` | Only `GET /v1/auth/me` stays (same response shape). `entra-login`, `dev-login`, `refresh`, `logout` are removed; the CSRF token is minted for cookie-authenticated callers as today (`bffSid` becomes `session.session.token`) |
| M | `libs/modules/identity/src/interface/http/dto/auth.dto.ts` | `EntraLoginDto`, `DevLoginDto`, `AuthResponseDto` removed; `MeResponseDto` kept |
| M | `libs/modules/{contracts,training}/src/*.module.ts` | import `EmployeesModule` instead of `IdentityModule` |
| M | `apps/api/src/app.module.ts` | imports `AuthModule` + `EmployeesModule` |
| R | `identity/src/interface/http/bff/` (`bff.controller.ts`, `bff.constants.ts`) | `/v1/bff/login`, `/callback`, `/dev-login`, `/logout`. Replaced by Better Auth's `/api/auth/*` |
| R | `identity/src/application/bff-session.resolver.ts` | |
| R | `identity/src/infrastructure/shared-auth/` (7 files) | `shared-auth.providers`, `user.drizzle-repository`, `auth-session.drizzle-repository`, `roles-claims.provider`, `entra-role-provisioning.hook` (logic moves to `staff-sign-in.hook.ts`), `drizzle-transaction.runner`, `audit-service.adapter` (replaced by `security-events.audit.ts`) |
| R | `identity/src/infrastructure/persistence/refresh-token.drizzle-repository.ts`, `domain/ports/refresh-token.repository.ts`, `domain/refresh-token.types.ts` | refresh tokens no longer exist |

### 1.3 The `createIdentity` call (sketch only)

```ts
createIdentity({
  product: 'opshub',                       // cookie: __Secure-opshub.session_token
  db, schema: identityAuthSchema, cache,   // opshub's Drizzle instance; generated tables (§2.1); Valkey (optional mode today)
  baseURL: env.APP_URL,                    // the SPA origin (same-origin cookie), https in production
  trustedOrigins: [env.APP_URL],
  presets: ['staff'],
  staff: { tenantId, clientId, clientSecret, domains: [/* Q4 */], allowGuests: false },
  mail: { jobs: throwingJobs, templates: stubTemplates },  // staff sends no mail; see 0.2 (3)
  hooks: { onStaffSignIn, onUserCreated }, // §3
  events: auditEventSink, logger: identityLoggerFrom(pino), onStorageDegraded,
});
```

Env: `BETTER_AUTH_SECRET` (new secret, ≥32 chars), `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID`, `ENTRA_CLIENT_SECRET` (**now mandatory**, not
optional as in v7), `APP_URL`. No `IDENTITY_ENCRYPTION_KEY` (that is `organizations` only). `IDENTITY_TEST_LOGIN=enabled` in CI/e2e
only (§6).

### 1.4 `libs/platform` (shared boilerplate with rally: see §8, Q8)

| | Path | Change |
| --- | --- | --- |
| R | `auth/jwt.strategy.ts`, `auth/jwt.guard.ts` (+ `jwt.guard.spec.ts`), `auth/bff-session-resolver.ts`, `auth/opshub-principal.ts` | |
| A | `auth/session-principal.guard.ts` (+ spec) | Replaces `JwtAuthGuard`. Reads the `{ session, user }` that identity's **global** `SessionGuard` already put on the request, loads the employee's roles/status, builds the principal, stamps the request context. Same exported name `Auth()` / `RequirePermission()` decorators, so the 296 `@Auth()` / `@RequirePermission()` uses do not change |
| M | `auth/decorators.ts` | `Public()` applies **both** metadata keys (`isPublic` and identity's `identity:public`), because identity registers its `SessionGuard` as `APP_GUARD` and would 401 every opshub `@Public()` route (health, webhooks inbound) otherwise. `ApiBearerAuth('access-token')` → cookie auth in OpenAPI |
| M | `auth/jwt.strategy.ts` → `auth/principal.ts` | The `JwtPayload` **type** is kept under the same name in this PR (44 files import it) as `{ sub, email, name, roles }` (+ `sessionId`); a rename is a later mechanical PR |
| M | `auth/policy.guard.ts`, `rate-limit/rate-limit.guard.ts` | Cookie name constant → `SESSION_COOKIE` (`__Secure-opshub.session_token`); no Bearer branch |
| M | `http/csrf.ts` (+ `csrf.spec.ts`) | See §1.7 |
| M | `platform.module.ts` | Drop `JwtModule`, `PassportModule`, `JwtStrategy`, `JwtAuthGuard`, `AuthTokenCache`, `AuthMetrics` providers |
| R | `context/als.middleware.ts`, `context/request-context.ts` | Replaced by `observability` (§4) |
| M | `config/env.schema.ts` (+ spec) | Remove `JWT_*`, `BFF_*`, `ENTRA_REDIRECT_URI`; add `BETTER_AUTH_SECRET`, `APP_URL`; `ENTRA_CLIENT_SECRET` becomes required when `ENTRA_*` are set |
| M | `errors/exceptions.ts`, `observability/index.ts`, `http/http-logging.interceptor.ts` | Context from `observability` (§4) |

### 1.5 Audit, metrics, alerts

- `libs/modules/audit/src/domain/audit-catalogue.ts`: the "Emitted by `@quynhonsemiconductor/identity`" block (`auth.login.sso`, `auth.login.dev`,
  `auth.logout`, `auth.switch_workspace`, `auth.token_theft_detected`) stays for **historical rows**; new rows use the same values where the meaning is the same:
  `sign_in.success` → `auth.login.sso`, `sessions.revoked` → `auth.logout`, `sign_in.failure` → a new `auth.login.failed` (v7 did not audit failures; confirm Q10).
- `libs/modules/audit/src/domain/identity-audit-actions.spec.ts` **breaks by design**: it greps v7's `dist` for `action:` literals and asserts at least six. v8 emits none through that path. Replace it with a spec over the event→action mapping in `security-events.audit.ts`.
- `infra/modules/stack/main.tf` (~L2095, ~L2350): the `auth-login-failure-rate` alarm and the dashboard widget read `auth_login_total{outcome="failure"}`, which only v7's `AuthMetrics.recordLogin` emits. v8 exposes `identity.security_events{event}`. **Rewire the alarm in the same PR as the cutover** or it goes silent. Also alert on `identity.mail_enqueue_failed` is moot (no mail) and on `onStorageDegraded`.
- `docs/runbooks/alerts/auth-login-failure-rate.md`: update the query and the failure meanings.

### 1.6 Web (`apps/web`)

| | Path | Change |
| --- | --- | --- |
| M | `src/pages/login/login-page.tsx` | `POST /v1/bff/login {returnTo}` → `POST /api/auth/sign-in/social {provider:'microsoft', callbackURL: returnTo}`; response `{ url }` → `location.assign(url)`. `returnTo` is validated by Better Auth against `trustedOrigins` (replaces the server-side open-redirect guard) |
| M | `src/widgets/app-shell/app-shell.tsx` | `POST /v1/bff/logout` → `POST /api/auth/sign-out`, then `resetBootstrap()` as today |
| M | `src/shared/api/auth-bootstrap.ts`, `use-current-user.ts`, `csrf.ts` | Unchanged contract (`GET /v1/auth/me` + `csrfToken`); comments updated. `credentials: 'include'` stays |
| A | `functions/api/auth/[[path]].ts` | The Pages Function that proxies `/api/auth/*` to the API origin, reusing `functions/_lib/proxy.ts` (spec added). **Without it the callback never reaches the API** |
| M | `functions/_lib/proxy.ts` | Header comment only; confirm `redirect: 'manual'` and the repeated `Set-Cookie` handling cover the callback's 302 + cookie (the existing stub-based spec already does) |
| M | `e2e/global-setup.ts`, `e2e/support/fixtures.ts` | `POST /v1/bff/dev-login` → `POST /api/auth/test-login {email}` (§6) |
| M | `src/shared/api/generated/api.ts` | Regenerated: the removed `/v1/auth/*` and `/v1/bff/*` operations disappear |
| — | `better-auth` client library | **Not added.** Two fetches do not justify a dependency whose version must track identity's pin (Q9) |

### 1.7 CSRF and cookies

- `requiresCsrfProtection` keys on the presence of the session cookie; the constant changes and the `EXEMPT_PATHS` list loses the `/v1/bff/*`, `/v1/auth/refresh` entries.
- **`/api/auth/*` is not behind opshub's CSRF hook**: it is mounted as a Fastify route outside `/v1`, and Better Auth enforces its own Origin/CSRF
  checks (`disableOriginCheck: false`, explicit). The hook is `onRequest` on the whole instance, so the plan needs `/api/auth/` added to the exemptions (and a test that proves a forged cross-site POST to `/api/auth/sign-out` is refused by Better Auth, not by us).
- The double-submit token stays bound to the session cookie value (`getUserInfo`), so a stolen token still cannot be replayed on another session.
- CORS: no change (same-origin); `x-correlation-id` stays exposed.

### 1.8 Infra, CI, config

| | Path | Change |
| --- | --- | --- |
| M | `infra/modules/stack/main.tf` | Secrets: add `better-auth-secret`; keep `COOKIE_SECRET`, `CSRF_SECRET`; **later** (PR 3) remove `jwt-private`. Env: remove `ENTRA_REDIRECT_URI`; add `APP_URL = local.app_url`. `ENTRA_CLIENT_SECRET` is injected unconditionally (drop the `entra_client_secret_set` gate for staff sign-in). Alarm rewire (§1.5) |
| M | `.github/workflows/backend-ci.yml`, `web-ci.yml` | Remove the "Generate ephemeral JWT keypair" steps and `JWT_PRIVATE_KEY`; add `BETTER_AUTH_SECRET` and `IDENTITY_TEST_LOGIN=enabled` for the e2e job |
| M | `vitest.config.ts`, `test/vitest.e2e.config.ts` | Test env: remove `JWT_*`, add `BETTER_AUTH_SECRET` |
| M | `gitops/values/opshub/*.yaml` (separate repo) | If opshub is already on the cluster: the same env/secret changes. Q7 |
| M | `docs/DIVERGENCE.md` | Declare the new auth shape vs rally until rally follows (§8, Q8) |
| M | `README.md`, `apps/web/README.md`, `docs/runbooks/*` | Login flow, env table |

---

## 2. Schema and data

### 2.1 New tables

Generated with the Better Auth CLI against the **same** `createIdentity` call (`scripts/auth-cli-config.ts`, as in the identity README), with the house
adjustments (`identity` schema, `uuid` ids, `timestamptz`). For `staff` + the admin plugin the set is: `identity."user"` (+ `role`, `banned`,
`ban_reason`, `ban_expires`), `identity.session` (+ `impersonated_by`), `identity.account`, `identity.verification`. No `organization`,
`member`, `sso_provider`, `two_factor` (those belong to presets opshub does not use).

- Drizzle schema: `db/schema/identity-auth.ts` (new), exported from `db/schema/index.ts`. The names `user`, `session`, `account` do not collide with the
  existing `employees`, `refresh_tokens`, `sso_identities` in the same `identity` schema.
- Migration `0035_identity_v8_tables.sql` (drizzle-kit generated, **additive only**): the four tables, indexes, FKs inside the auth tables. Privileges come from the
  `ALTER DEFAULT PRIVILEGES` in `0012`, so `opshub_app`/`opshub_worker` can use them; a privilege test asserts it (the least-privilege CI job already runs the e2e suite as `opshub_app`).
- It is **expand-only**, which is what the `Migration upgrade path` CI job and the expand-contract advisory check. v7 tables stay untouched.

### 2.2 Data migration `0036_identity_v8_backfill.sql` (one transaction)

Differs from the generic template because the source is `employees`:

```sql
BEGIN;
-- pre-check (also run as a CI assertion on the seeded database): no two employees collide when lower-cased
--   SELECT lower(email) FROM identity.employees GROUP BY 1 HAVING count(*) > 1;   -- must return 0 rows

INSERT INTO identity."user" (id, name, email, email_verified, banned, ban_reason, created_at, updated_at)
SELECT e.id,                                   -- SAME id: every FK to employees.id keeps meaning
       e.display_name,
       lower(e.email),
       true,                                   -- v7 treated every employee as verified (toUser(): emailVerified: true)
       e.status = 'offboarded',                -- the v7 gate blocked 'offboarded'; 'on_leave' stays able to sign in
       CASE WHEN e.status = 'offboarded' THEN 'migrated from v7: offboarded' END,
       e.created_at, now()
FROM identity.employees e
ON CONFLICT (id) DO NOTHING;

INSERT INTO identity.account (id, account_id, provider_id, user_id, created_at, updated_at)
SELECT uuidv7(), s.provider_sub, 'microsoft', s.user_id, s.created_at, now()
FROM identity.sso_identities s
JOIN identity."user" u ON u.id = s.user_id
WHERE s.provider = 'entra'
ON CONFLICT DO NOTHING;
COMMIT;
```

- Employees created by HR **before** their first Entra login have no `sso_identities` row; they get a `user` row and no `account`. On first Microsoft sign-in
  Better Auth finds the user by email and links the account (a tenant member comes with a verified email), so **ids are preserved**. This is the case the guide's "copy users" did not have to consider.
- `uuidv7()` needs PostgreSQL 18 (the dev compose uses 18; confirm the RDS/cluster engine, Q7). If not, generate ids in the migration runner.
- The backfill is re-runnable (`ON CONFLICT`) and is also expressed as a test: after migration, `count(user) = count(employees)` and every `account.user_id` exists.

### 2.3 Keeping `user` and `employees` in step afterwards

- **Employee created by HR** (`EmployeeService.create`): insert the `user` row in the same transaction (same id, `email_verified = true`). Otherwise the first sign-in would create a `user` with a *new* id.
- **Unknown person signs in** (JIT): Better Auth creates the `user`; `hooks.onUserCreated` creates the `employees` row **with `id = user.id`** (default fields as v7's `upsertBySsoIdentity`: email, display name, `entra_oid`). The hook runs after the transaction and before the request answers; the principal guard also upserts on demand, so a request that races the hook still finds its employee.
- **Email or name change**: employees' email is the join key to Entra; a change goes through `EmployeeService` and updates the `user` row.
- **Invariant, enforced by a ratchet test:** every `employees.id` has a `user.id` and vice versa, except explicitly listed system rows.

### 2.4 Sessions and the rollout note

**Old sessions are not migrated** (v7 BFF sessions live in Valkey, refresh tokens in `identity.refresh_tokens`; neither exists in v8). The release note and the Slack/Teams
announcement say, verbatim:

> After this release you will be signed out once and asked to sign in with your Microsoft account again. Nothing else changes. Sessions now last up to 12 hours.

Unused v7 data: `refresh_tokens`, `sso_identities`, `employees.entra_oid` stay readable for 30 days (rollback, §7), then PR 3 drops them (contract step).

---

## 3. Roles: Entra App Roles → opshub authorization (behaviour kept exactly)

### 3.1 What v7 does (and v8 must keep)

1. The Entra id_token carries `roles: ["admin", …]` (App Role **values**; they must equal opshub role keys: `admin`, `it-admin`, `security`, `hr`, `manager`, `helpdesk`, `auditor`, `employee`).
2. On **every** SSO login, `EntraRoleProvisioningHook` computes `roleKeys = roles.length > 0 ? roles : ['employee']` and calls
   `AuthzAdminService.syncUserRolesByKeys(user.id, roleKeys, { sub: user.id, email })`.
3. `syncUserRolesByKeys` (unchanged, in `libs/modules/authz`): keys that match no role are **ignored** (an unmapped Entra role never grants access); global assignments are
   reconciled (granted/revoked) in one transaction with its audit entry; scoped (non-global) assignments are untouched; the permission cache epoch is bumped; `employees.roles` is derived.
4. Authorization itself is **not** read from the token: `PolicyGuard` resolves permissions from the database on every request. `JwtPayload.roles` is for display/`/me` only.

### 3.2 v8 design

`hooks.onStaffSignIn(user, { oid, email, roles, claims })` (new in app-platform, §0.2 (1)) calls the **same** reconciliation, so nothing in `authz` changes:

```ts
async onStaffSignIn(user, { roles }) {
  const roleKeys = roles.length > 0 ? roles : ['employee'];
  await authzAdmin.syncUserRolesByKeys(user.id, roleKeys, { sub: user.id, email: user.email });
}
```

Requirements on the hook, so behaviour is identical:
- runs on **every** Microsoft sign-in (not only the first), after the user and the employee exist and **before the first request** with the new session is served;
- receives `roles` as `string[]` (absent claim → `[]`), already validated as an array of strings;
- a failure of the sync **fails the sign-in** (v7: the login errored and no session was minted); it must not leave a session with stale roles.

`/v1/auth/me` returns `roles` from `employees.roles` (read per call) in place of the token claim, and `permissions` from `AuthzService.resolve` exactly as now.

Alternative if the hook is refused: read the user's `appRoleAssignments` from Microsoft Graph with the existing client-credentials `GraphClientService` at sign-in. It reaches the same
assignments but is **not** the same source (group-inherited roles, latency, a second failure mode), so it would not be "exactly the existing behaviour". Not recommended (Q1).

### 3.3 Offboarding and re-activation (behaviour kept)

| v7 | v8 |
| --- | --- |
| `updateStatus('offboarded')` → `refreshTokenRepo.revokeAllForEmployee(id)` and `authCache.revokeUser(id, 24h)` (live access tokens blocked within ms) | `revokeUserSessions(auth, id)` + `setUserBanned(auth, id, true, 'offboarded')` (app-platform helpers, §0.2 (2)); sessions are database rows, so revocation is effective on the next request. The principal guard also rejects an `employees.status = 'offboarded'` principal, so a revoked-but-cached copy cannot survive (defence in depth) |
| `'active'` → `authCache.unrevokeUser(id)` | `setUserBanned(auth, id, false)` |
| login of an `offboarded` employee blocked (`inactive` gate) | a banned user cannot sign in (Better Auth admin plugin) |

`fast-revocation.e2e.spec.ts`, `offboarding-revocation.e2e.spec.ts` and `authz-revocation.e2e.spec.ts` keep their assertions and change only how they authenticate.

---

## 4. Context, logging, errors (one store)

Today opshub runs **two** context stores: its own `AsyncLocalStorage` (`libs/platform/src/context`, set by `AsyncLocalStorageMiddleware` on `forRoutes('*')`, accepting only UUIDs) for the API, and
`observability`'s store (`withJobContext`) for the worker/outbox. Contract §7 allows 1–128 `[A-Za-z0-9._:-]`, `traceparent`, one id for the whole life of a request.

| Step | Change |
| --- | --- |
| 1 | `apps/api/src/main.ts` / `bootstrap`: call `enableCorrelationId(app)` (platform-http ≥ 4.2.0) right after `NestFactory.create` and before `bootstrapApp`. It registers with `app.use()`, so it runs before every module middleware and **also covers the `/api/auth/*` Fastify mount** (which Nest middleware never saw) |
| 2 | Delete `AsyncLocalStorageMiddleware` and `consumer.apply(...)` in `AppModule`; delete `libs/platform/src/context/*` |
| 3 | `RequestContextService` → `observability`'s (`get()`, `getCorrelationId()`, `getUserId()`, `setAuthContext(workspaceId, userId, sessionId)`). The principal guard calls `setAuthContext(undefined, userId, sessionId)` (replaces the `store.userId/userEmail` writes; `userEmail` has no reader and is dropped) |
| 4 | `app.module.ts`: `REQUEST_CONTEXT` binds to observability's service (it has `getCorrelationId`/`getUserId`, the port `GlobalExceptionFilter` needs); the `LoggerModule` `mixin` reads the same service (already shaped that way); `HttpLoggingInterceptor` and the worker use it unchanged |
| 5 | `GlobalExceptionFilter` (platform-http) stays; it now puts the caller's valid id, or the generated one, in `error.correlationId` instead of opshub's UUID-only id |
| 6 | The identity logger/events: `logger: identityLoggerFrom(pino)` and the audit-backed event sink; `onStorageDegraded` logs with `failOpenLog`-style field so the existing security fail-open alarm applies |
| 7 | Contract §4: the opshub pino options should converge on `observability`'s `createLoggerOptions` (service/env/version fields, redaction list incl. `set-cookie` and `x-csrf-token`). Out of scope for this migration unless Q8 says rally moves too; the redaction list gets the two missing entries in this PR because the session cookie now travels in `Set-Cookie` on `/api/auth/*` |

Behaviour change to expect: an `X-Correlation-Id` that was not a UUID used to be replaced; now it is kept (if valid). Error bodies and logs carry whatever the caller sent, validated.

---

## 5. Entra changes the OWNER must make (to relay)

App registration **"OpsHub Dev"** (the only one that exists):

1. **Add the redirect URI** (type *Web*): `https://opshub-dev.qnsc.vn/api/auth/callback/microsoft`.
   - This is the **SPA host**, not `opshub-api-dev.qnsc.vn`: see §0.1. Keep the v7 URI (`https://opshub-dev.qnsc.vn/v1/bff/callback`) registered until the 30-day rollback window ends.
   - If the intended host really is the API host, say so: it needs a different cookie design and the Pages proxy plan changes (Q3).
2. **Optional claim `email`** on the ID token: already added (confirm it is *ID token*, v2.0, and the manifest has `acceptedAccessTokenVersion` 2 or the app is v2 for sign-in). `oid` and `tid` are present by default in v2 id_tokens (ADR check M2).
3. **App Roles** (`admin`, `it-admin`, `security`, `hr`, `manager`, `helpdesk`, `auditor`, `employee`): confirm the **values** equal the opshub role keys exactly (case-sensitive) and the users/groups are assigned in *Enterprise applications → Users and groups*. The `roles` claim needs nothing else.
4. **Single-tenant** (*Accounts in this organizational directory only*), and **"Assignment required"** decision: v7 behaviour was "any member of the tenant gets `employee`". Keep it unless the owner says otherwise (Q5).
5. **Client secret**: v7's `ENTRA_CLIENT_SECRET` was optional and the registration "has no secret minted yet" (infra comment). v8 sign-in cannot work without it: mint one, put it in Secrets Manager (`entra-client-secret`), note the expiry date and a rotation owner.
6. **Separate prod app?** Only "OpsHub Dev" exists and production **has never launched** (`gitops/values/opshub/base.yaml`). Recommendation: **yes, a separate "OpsHub" registration for production**, with `https://opshub.qnsc.vn/api/auth/callback/microsoft` as its only redirect URI, its own secret and its own App Role assignments. Reusing the dev app puts localhost/dev redirect URIs and the dev secret's blast radius on production. Decision needed before the prod cutover (Q2).
7. Cloudflare Access sits in front of the API (`expose: protected`): confirm the `/api/auth/callback/*` path is reachable for the browser's top-level redirect (Q6).

---

## 6. Test plan

### 6.1 In opshub CI (automated; must be green before review)

**Unit (`pnpm test`)**
- `session-principal.guard.spec.ts`: no session → 401 `AUTH_UNAUTHENTICATED`; banned/offboarded → 401; principal fields (`sub`, `email`, `name`, `roles`); `Public()` routes skip both guards; ALS stamped with the user id.
- `staff-sign-in.hook.spec.ts`: `roles: []` → `['employee']`; `['admin']` → sync with `['admin']`; unmapped key ignored (delegates to authz); runs per sign-in; a sync failure rejects.
- `user-directory`: employee create writes the `user` row in the same transaction (rolled back together); invariant ratchet (every employee has a user).
- `security-events.audit.spec.ts` replaces `identity-audit-actions.spec.ts` (event → `AUDIT_ACTION`); `audit-catalogue-single-source` stays green.
- `csrf.spec.ts`: new cookie name, `/api/auth/*` exemption, Bearer branch gone.
- `env.schema.spec.ts`: new/removed variables.
- Web: `proxy.spec.ts` for the `/api/auth` function (repeated `Set-Cookie`, `redirect: 'manual'`, forwarded host/proto); login-page and app-shell specs.

**Migration job** (`Migration upgrade path` + a new assertion): apply 0035/0036 on the baseline seed; `count(user) = count(employees)`; `account` rows = Entra identities; ids equal; re-run is a no-op; `opshub_app` can `SELECT/INSERT/UPDATE/DELETE` the new tables.

**E2E (`pnpm test:e2e`, in-process Fastify `inject`, least-privilege role)**
- `test/e2e/support/harness.ts`: `login()` uses `POST /api/auth/test-login` (`IDENTITY_TEST_LOGIN=enabled`, `NODE_ENV=test`) and returns the cookie; `bearer()` and `accessToken` go away; `apiRequest` sends the cookie and fetches the CSRF token for state-changing verbs. Six spec files that read `accessToken`/`Bearer` are updated; the other ~35 go through the harness unchanged.
- Behaviours that must stay green: `fast-revocation`, `offboarding-revocation`, `authz-revocation` (revoke → next request 401), `csrf-protection` (cookie-authenticated POST without token → 403; with token → ok), `idempotency`, rate limiting keyed on the new credential.
- New: a **mock-IdP sign-in** end to end using identity's `/testing` mock IdP (Entra-shaped id_token with `roles`) proving: new person → employee row with `id = user.id`; existing HR-created employee → linked, same id; `roles` reconciled; second sign-in with changed roles re-syncs; `tid` mismatch and a guest are refused; `@opshub.local` fixtures only exist for `test-login`.
- `/api/auth/*` is mounted outside `/v1` and outside `RouteAuthzAudit`: a spec lists the mounted auth routes so a new unaudited route cannot appear unnoticed.
- Identity's own conformance kit is **not** re-run by opshub; its version pin is the guarantee.

**Playwright (`web-ci`)**: global-setup via `test-login`; the existing shell/permission specs unchanged.

### 6.2 Manual check M3, after the deploy to **dev**

Run by the owner with the engineer on a call; record the result in the PR. Pass/fail criteria:

1. `curl -sI https://opshub-dev.qnsc.vn/api/auth/ok` → 200 (the proxy and the mount are reachable) and `X-Correlation-Id` present.
2. Start sign-in from the SPA and read the `Location`/authorize URL: **`redirect_uri=https%3A%2F%2Fopshub-dev.qnsc.vn%2Fapi%2Fauth%2Fcallback%2Fmicrosoft`**: `https`, the **SPA host**, no `http`, no internal service hostname, no `:3000`, no API host. (Behind Cloudflare Tunnel/Envoy this is the check that `baseURL` wins over `X-Forwarded-*`; `trustProxy` stays `true` for the client IP.)
3. Complete the Microsoft sign-in with a real tenant member: lands on the SPA with `Set-Cookie: __Secure-opshub.session_token; HttpOnly; Secure; Path=/` **on the SPA host**; `GET /v1/auth/me` returns the right `sub` (= the existing `employees.id`), `email`, `roles` (the App Roles assigned) and `permissions`.
4. A user with **no** App Role gets `employee`; a user with `admin` gets the admin permission set; change the role in Entra, sign out/in: permissions change.
5. A B2B guest and a user from another tenant are refused (error redirect, no account created).
6. Sign out: cookie cleared, `GET /v1/auth/me` → 401. Offboard an employee in the UI while they hold a session: their next request → 401.
7. After 12 h (or by editing the row's `expires_at` in dev) the session is dead on the next request.
8. No sign-in related `error` lines in the logs; one `sign_in.success` event and one audit row per sign-in; the correlation id of the sign-in request appears in the log lines and in an error body.

---

## 7. Cutover, rollback, flag

### 7.1 Why no runtime feature flag

v7 and v8 are different majors of the same package with different guards, cookies and tables. A flag would need both loaded at once (an npm alias for v7), two guards on every route and two cookie
families, and every test twice. For an internal tool with one environment in use and production not yet launched that is more risk than it removes. The cutover is **per environment, expand → switch → contract**.

### 7.2 Sequence of PRs

| # | Repo | PR | Deploys on merge? | Reversible by |
| --- | --- | --- | --- | --- |
| 0a | app-platform | identity: `hooks.onStaffSignIn` (Entra claims) | release PR | not used until opshub adopts it |
| 0b | app-platform | identity: `revokeUserSessions`, `setUserBanned` (+ optional `mail`) | release PR | idem |
| 1 | opshub | `feat(identity): add the Better Auth tables and backfill them` (0035, 0036 only; no code reads them) | yes (migrator) | additive; ignore |
| 2 | opshub | `feat(identity): move opshub to identity 8` (§1: api + worker split + web + infra env + CI + alarm) | api and web release PRs | redeploy the previous api and web images (7.3) |
| 3 | opshub | `chore(identity): drop the v7 auth tables, columns and secrets` (contract step, ≥30 days later) | yes | restore from backup (don't need to) |

Entra: the redirect URI is registered **before** PR 2 is merged (the owner, §5). Secrets: `better-auth-secret` and `entra-client-secret` exist in Secrets Manager before PR 2's infra applies, because ECS cannot start a task whose secret has no value (the repo's own comment on `var.entra_client_secret_set`).

### 7.3 Cutover (dev first)

1. Merge PR 1; migrator runs; verify counts (§6.1).
2. Announce the one-time sign-out (§2.4).
3. Owner merges the PR 2 release PRs (api, web). **The two deploy separately**, so for a few minutes the old SPA may talk to the new API (login button gets 404 from `/v1/bff/login`). Acceptable for dev; for prod deploy the web release first only if the API still serves the old routes, which it will not. Prod has no users yet, so it needs no window (Q2).
4. Run M3 (§6.2). Only then proceed to prod.

### 7.4 Rollback (until PR 3)

- Redeploy the previous api and web images (the release PR revert is the owner's action, never mine). Nothing destructive ran: v7 tables, `employees.entra_oid`, v7 secrets and the v7 redirect URI are all still there.
- Data written during the v8 window stays valid for v7: new employees exist in `employees` (JIT/HR create), role assignments are in the authz tables, offboarding set `employees.status`. The only v8-only data is `identity.user/account/session`, which v7 ignores.
- **Sessions:** v8 sessions are dead after the rollback (users sign in on v7). v7 BFF sessions in Valkey were not deleted by the cutover and still honour their cookie until their TTL (30 days). For a security-motivated rollback the owner flushes the v7 BFF session keys under the `opshub:` Valkey prefix (the exact key pattern comes from `BffSessionStore` in identity 7.1; I have not verified it, the worktree has no `node_modules` yet). For the forward direction nothing needs flushing, but PR 2 should delete them once the 30 days pass (PR 3).
- If the problem is Entra (secret expired, redirect URI removed), rollback is not needed: fix the registration; `ENTRA_CLIENT_SECRET` expiry has an alert/date (§5).
- `test-login` can never be on in production: `IDENTITY_TEST_LOGIN` is only set in CI, identity refuses it unless `NODE_ENV` is `test` or `development`, and a boot-time test in opshub asserts that the production env schema rejects `IDENTITY_TEST_LOGIN`.

---

## 8. Risks and open questions

### 8.1 Open questions (need an answer from you / the owner)

| # | Question | My default |
| --- | --- | --- |
| Q1 | OK to add `hooks.onStaffSignIn` to identity (app-platform, before opshub can finish)? Or do you prefer Graph `appRoleAssignments` (not the same source, §3.2)? | Add the hook |
| Q2 | Separate production Entra app, and does prod need a cutover window (no users yet)? | Separate app; no window |
| Q3 | Confirm the redirect URI host is the **SPA** host (`opshub-dev.qnsc.vn`), not `opshub-api-dev.qnsc.vn`. Your note said `<opshub-api-host>`; same-origin design says SPA host | SPA host |
| Q4 | `staff.domains`: which email domains do employees use (`qnsc.vn` only? aliases?) Anyone whose Entra email is off the list is refused; seed fixtures are `@opshub.local` (test-login only) | `['qnsc.vn']`, to be confirmed with a query on real `employees.email` |
| Q5 | Keep "any tenant member may sign in and gets `employee`", or turn on Entra *Assignment required*? | Keep v7 behaviour |
| Q6 | Cloudflare Access in front of the API (`expose: protected`): is the callback path exempt/handled? Is opshub running on ECS (Terraform) or the cluster (gitops) for the first cutover? Both exist in the repo | Ask owner |
| Q7 | PostgreSQL engine version where the migration runs (`uuidv7()` is PG18) and pgbouncer mode (transaction pooling is fine for Better Auth's transactions) | PG18 |
| Q8 | `libs/platform` is shared boilerplate with rally (`docs/DIVERGENCE.md`). opshub moves first (LMS, then opshub, then rova). OK to declare the divergence until rally follows? | Yes |
| Q9 | Add `platform-db` only as an identity peer (types)? And is a `better-auth` client library in the SPA wanted? | Peer yes, client no |
| Q10 | Audit failed sign-ins (`sign_in.failure` → new `auth.login.failed` action)? v7 did not | Yes, ids and IP only |
| Q11 | Is a 12-hour session (was 30 days) acceptable, or does opshub need a different cap? The cap is a platform default; changing it is an app-platform decision | Accept 12 h |

### 8.2 Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Entra roles not delivered (§0.2 (1)) | Everyone is `employee`; admins lose access | Blocker; the cutover PR does not merge without the hook and the mock-IdP e2e proving `roles` |
| `user.id ≠ employees.id` for someone | Actor-id FKs break, permissions look empty | Backfill keeps ids; HR-create writes `user` in the same tx; ratchet test; M3 step 3 checks `sub` |
| Worker loads identity's Fastify mount | Worker crash loop | `EmployeesModule`/`AuthModule` split; a worker boot test |
| Global `SessionGuard` 401s opshub `@Public()` routes | Health checks fail, ALB/cluster restarts pods | `Public()` applies both keys; a test on `/v1/readyz`, `/livez`, webhooks inbound |
| Pages Function missing for `/api/auth/*` | Callback 404; nobody can sign in | Function + spec in PR 2; M3 step 1 |
| Alarm `auth-login-failure-rate` goes blind | Login outage not noticed | Rewire in the same PR; test the PromQL against the event name in a spec like `fail-open.spec.ts` |
| Entra client secret missing/expired | Sign-in fails closed | Secret created before PR 2; expiry tracked; alarm on `sign_in.failure` rate |
| Session cap 12 h vs 30 d | Daily re-login | Communicate; Entra SSO usually makes it a redirect |
| Cookie is `Lax`, not `Strict` | Slightly weaker CSRF baseline | opshub's double-submit CSRF stays on all state-changing `/v1` requests |
| `better-auth` is ESM-only, identity loads it with `require(esm)` | Fails on Node < 22.12 or in a bundler/test runner that cannot | Node 24 in CI and the Dockerfile; a smoke test boots the api under vitest and under the production build |
| `libs/platform` diverges from rally | Two auth shapes for a while | Declared in `DIVERGENCE.md`; rally follows after opshub |
| App-platform releases lag | Cutover blocked | 0a/0b are small; the expand-only PR 1 can land meanwhile |
| Rollback leaves v7 Valkey sessions alive | Stolen-session window of 30 d if rolled back for a security reason | Flush the v7 BFF session keys as part of a security rollback; PR 3 cleans up |

### 8.3 Explicitly not in scope

Organizations/SSO for partners (`organizations` preset), password/Google sign-in (`public` preset), impersonation (off in 8.0.x), moving to `platform-jobs`/`platform-db`/`createLoggerOptions` as a whole,
renaming `JwtPayload`, moving rally.

---

## 9. What I need from you to start Phase 2

1. Answers to Q1–Q6 (the rest have defaults).
2. A go to open the two app-platform PRs (0a, 0b).
3. Confirmation that the owner will do §5 items 1, 3, 5 before PR 2 is merged, and that merging the opshub release PRs stays with the owner.
