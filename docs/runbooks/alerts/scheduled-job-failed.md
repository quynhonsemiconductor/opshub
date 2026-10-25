# Alert: scheduled-job-failed

A scheduled job (anything that runs through `ExclusiveJob`: the crons and, in opshub, the Graph syncs) threw. `job_failures_total{job_name}` increased in
the last hour, per job, with **no volume floor**.

## What this means

The job is not doing its work: a sweep, a sync or a purge. Unlike `worker-job-failure-rate`, which needs a *share* of at least `min_samples_5m` runs
in five minutes and so never opens for jobs that run hourly or daily, this fires on a single failing job. It stays firing for up to an hour after the
last failure, so a daily job that failed once is visible all morning.

## First checks

1. The alert names the job (`job_name` label; observability >= 0.6.0. Before that every job of the worker shared one series and the alert cannot name it: read the worker log). Find its failure in the worker log: Logs Explorer, `service_name="<product>-worker"`, `level="error"`,
   `context` or `msg` naming the job. A failure raised **before** the job's own code (the lock) logs as `[Scheduler] ...` rather than under the job.
2. Did it start at a deploy? Compare with the Deploys annotation. A dependency upgrade that changes a shared primitive fails *every* job at once:
   on 2026-10-15 platform-runtime 0.2.0 called `CacheService.tryLock`, which does not exist before platform-cache 3.2.0, and every `ExclusiveJob` failed with
   `this.cache.tryLock is not a function`. Several jobs alerting together with one message points at a shared cause, not at the jobs.
3. Cache (Valkey): `ExclusiveJob` takes its lock there. With the cache down it falls back to a database advisory lock, so a cache outage alone is not a failure.

## Catching up

Most jobs are sweeps and are safe to leave: the next run does the work. Check the job's own description before assuming. Anything driven by a
*request row* (opshub's Graph task outbox) is different: a row that failed five times is dead-lettered and **is not retried by itself**. List and
re-queue it deliberately.

## Escalate if

More than one job is failing with the same message after a deploy: roll the worker back or fix forward before anything else.
