# Alert: worker-job-failure-rate

Ratio of `job_failures_total` to `job_runs_total` over 5 minutes has crossed the
environment's threshold (5% prod / 10% develop) for 5 minutes straight.

## What this means

A meaningful share of background jobs (cron jobs — security-posture sync, compliance
sync, audit cleanup, delegation expiry, review-due, storage cleanup, request expiry,
contract expiry, SLA breach — plus the webhook and notification/email relays) are
failing. This is the worker process (`apps/worker`), not the API.

## First checks

1. Overview dashboard, "Worker job success vs failure rate" — confirm the shape (a
   step change at a deploy vs a gradual climb).
2. Logs Explorer / Recent errors, filtered to `opshub-worker` — the actual exception is
   almost always visible here; worker errors are structured the same way API errors are.
3. Check the Deploys annotation — did this start right after a deploy to the worker?
4. Check which JOB TYPE is failing (log `context` field). Different jobs have different
   likely causes:
   - Email relay: check `MAIL_FROM_EMAIL`/SES verification and the SES bounce/complaint
     queue depth (CloudWatch).
   - Webhook relay / notification relay: check the outbox table for `status = 'failed'`
     rows and any outbox dead-letter CloudWatch alarm.
   - Compliance/security-posture sync crons: check the upstream source's own health and
     rate limits.
5. Check cache (Valkey) health — relay wake signals and `ExclusiveJob`'s own locking
   depend on it; see the `cache-*` CloudWatch alarms.

## Likely causes, roughly in order

- Bad deploy to the worker
- A downstream dependency down or rate-limiting (SES, Microsoft Graph, an external
  compliance/security data source)
- Cache (Valkey) unreachable, breaking `ExclusiveJob` locking or pub/sub-based wake
  signals
- A DB migration or schema change the worker's queries don't yet account for

## Escalate if

Failures keep climbing and no single job type/error message dominates, or an outbox
dead-letter alarm is also firing — that combination means delivery-critical paths are
backing up, not just one flaky job.
