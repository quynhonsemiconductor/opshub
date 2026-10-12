# Alert: auth-login-failure-rate

Ratio of failed to total Microsoft sign-ins (`identity_security_events_total`, `event="sign_in.failure"`
over `sign_in.success` + `sign_in.failure`) over 15 minutes has crossed the environment's threshold
(15% prod / 30% develop) for 15 minutes straight, with at least the environment's minimum number of
attempts in the window.

## What this means

A meaningful share of sign-ins through identity 8 (`POST /api/auth/sign-in/social`, then Microsoft, then
`GET /api/auth/callback/microsoft`) are being refused. The 15-minute window (longer than the other rules'
5m) is deliberate: sign-in volume is naturally low, and a shorter window would be noisy with few samples.

## Why this alert exists, specifically

identity reports every refusal to the caller as a redirect with a generic error (`?error=...`) and tells an
unauthenticated browser nothing about why: a foreign tenant, a guest, an address outside `qnsc.vn`, a failed
role sync and an expired client secret all look the same from outside. The HTTP error-rate alert **cannot**
see this: a refused sign-in is a redirect, not a 5xx. `identity.security_events{event="sign_in.failure"}` is
the only signal that separates "sign-in is broken" from normal traffic.

## First checks

1. Overview dashboard, "Login success vs failure rate" panel: confirm the shape (a step change at a deploy vs a
   gradual climb vs a sudden spike).
2. Logs Explorer, `opshub-api`, searching the correlation ids around the spike:
   - `security event: sign_in.failure` (identity's own line; carries ids and the client address only)
   - `identity.auth_handler_threw` (the handler threw: a bug or a dependency, with the stack)
   - `STAFF_SIGN_IN_REFUSED` (the product hook threw, so the sign-in was refused and no session minted: the
     role sync or the employee write failed; the cause is the error logged just before it)
3. Audit log: `auth.login.failed` entries (user id and IP only).
4. Check the Deploys annotation: did this start right after a deploy?
5. Check the Entra app registration's **client secret expiry**. An expired secret fails EVERY sign-in, not a
   subset, and is the most common cause. The secret is `opshub/<env>/entra-client-secret` in Secrets Manager.

## Likely causes, roughly in order

- Expired or rotated Entra client secret (`ENTRA_CLIENT_SECRET`)
- The redirect URI registered on the app is not exactly `${APP_URL}/api/auth/callback/microsoft`
  (`AADSTS50011`), or `APP_URL` changed
- `STAFF_SIGN_IN_REFUSED`: the database or the authz layer failed during the role sync
- Entra tenant/app registration misconfiguration (consent revoked, the `email` optional claim removed, so
  members have no address to match against `qnsc.vn`)
- Prod only: `entra_client_id` is empty until the production app registration exists (see
  `infra/live/prod/variables.tf`), in which case the env schema refuses to boot at all, so this alert is not
  the symptom you would see first
- A genuine wave of user error (people from another tenant, personal accounts), distinguishable from the above
  by NOT correlating with a deploy or config change

## Escalate if

The failure rate keeps climbing with no obvious cause, or nobody can sign in at all: that combination means
the Entra integration itself is down, not a subset of users hitting an edge case.
