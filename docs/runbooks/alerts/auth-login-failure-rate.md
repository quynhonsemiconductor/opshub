# Alert: auth-login-failure-rate

Ratio of failed to total login attempts (`auth_login_total`, `outcome="failure"`)
over 15 minutes has crossed the environment's threshold (15% prod / 30% develop)
for 15 minutes straight.

## What this means

A meaningful share of login attempts through `POST /auth/entra-login` (SSO) or
`POST /auth/dev-login` (non-production only) are failing. The 15-minute window
(longer than the other rules' 5m) is deliberate — login volume is naturally low, and a
shorter window would be noisy with few samples.

## Why this alert exists, specifically

Both `AuthController.entraLogin` and `.devLogin` call through to
`AuthService.ssoLogin`/`.devLogin`, and any failure there surfaces to the caller as
a generic `401` — internal detail (an invalid Entra id_token, an inactive employee
record) is never leaked to an unauthenticated client. That means the HTTP error-rate
panel/alert **cannot** see this: a 401 on a login route doesn't count toward
`http_server_errors_total` the same way a 5xx does, and even if it did, "401" alone
doesn't say WHY. `auth_login_total` is the only signal that distinguishes "login is
broken" from "normal traffic."

## First checks

1. Overview dashboard, "Login success vs failure rate" panel — confirm the shape (a
   step change at a deploy vs a gradual climb vs a sudden spike).
2. Logs Explorer / Recent errors, filtered to `opshub-api` — the actual exception is
   logged server-side even though the caller never sees it.
3. Check the Deploys annotation — did this start right after a deploy?
4. Check Entra/Azure AD's own service health and the app registration's client secret
   expiry — an expired secret fails EVERY SSO login, not a subset.
5. If it's `dev-login` failing in develop: check that the target employee record is
   still active — `AuthService` rejects dev-login for an inactive/missing employee.

## Likely causes, roughly in order

- Expired or rotated Entra client secret (`ENTRA_CLIENT_SECRET`)
- Entra tenant/app registration misconfiguration (redirect URI mismatch, consent
  revoked) — note prod's `entra_client_id` is empty until the production app
  registration is created (see `infra/live/prod/variables.tf`), which means EVERY
  prod SSO login fails until that go-live step is done
- Bad deploy to the identity module
- A genuine wave of user error (expired sessions, deactivated accounts) —
  distinguishable from the above by NOT correlating with a deploy or config change

## Escalate if

The failure rate keeps climbing with no obvious cause, or nobody can log in at all —
that combination means the SSO integration itself is down, not a subset of users
hitting an edge case.
