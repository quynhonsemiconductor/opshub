# Alert: authenticated-429

`rate_limit_authenticated_429_total` has increased at all over the last 5 minutes
(`increase(rate_limit_authenticated_429_total{deployment_environment_name="prod"}[5m]) > 0`).

## What this means

**A signed-in person was throttled.** This is not routine back-pressure and it is not a request for
a retry: OpsHub's per-user tiers are sized so that normal work never reaches them (1200 requests a
minute for DEFAULT, AUTH_ME and STRICT; the owner requires that staff are never rate-limited while
working fast). Any value in production is a defect, either in the tier sizing or in a client that is
looping.

The counter is emitted only by `UserRateLimitGuard`, after identity has verified the caller, so
every increment is attributable to a real user. It carries two bounded labels:

- `tier` — `DEFAULT`, `AUTH_ME`, `STRICT`, `AI` or `UPLOAD`
- `route` — the route template, e.g. `/v1/assets`, never a concrete path

The pre-auth per-address bucket (`PRE_AUTH_IP_BUCKET`) is NOT counted here: identity has not run
when it refuses, so there is no user to name. An IP-bucket refusal is normal under a sign-in flood;
it is covered by `auth-login-failure-rate` and `rate_limit` fail-open logs.

## First checks

1. Which `tier` and `route` incremented? A spike on one route is a client loop or an expensive
   screen; a spike across everything is a tier set too low for real work.
2. Find the person: the same refusal logs one warning line with `event=rate_limit.authenticated_429`,
   `userId`, `tier`, `route` and the `limit` that applied. Search the API logs in Loki for that event
   in the same window.
3. `AI` and `UPLOAD` are tight ON PURPOSE (10/min and 30/min per user). A 429 there is the control
   working as intended if the user is genuinely looping inference or uploads — confirm before
   treating it as a bug.
4. Did this start after a deploy? Check the Deploys annotation; a client change that polls a route in
   a loop shows up here first.

## Likely causes, roughly in order

- A client retry loop: the SPA's 429 retry (backoff, capped attempts) against a route that keeps
  refusing, or a background poll with no delay.
- A screen fanning out far more requests per action than expected (N+1 reads over a list endpoint) —
  the right fix is the screen, not a bigger limit.
- A `RATE_LIMIT_DEFAULT_LIMIT` override lowered in the deployed environment. Production refuses a
  value below the floor, so this would mean a deploy bypassed the schema — verify the running value.
- Genuine abuse from one compromised account; `userId` from the log line answers this directly.

## Do not

- Do not raise `AI` or `UPLOAD` to clear this alert. Those exist to cap cost and object-storage
  writes; a signed-in 429 there is a product or client question first.
- Do not lower `RATE_LIMIT_IP_LIMIT`. Signed-in traffic refunds its address slot as soon as identity
  verifies the caller, so this counter cannot be caused by the office NAT sharing one address.

## Escalate if

A non-AI/non-UPLOAD tier keeps incrementing after the client loop is ruled out, or the `limit` logged
with the refusal is below 1200 in production.
