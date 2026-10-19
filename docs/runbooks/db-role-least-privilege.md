# Runbook — least-privilege database roles

## Why

The API, the worker and the migrator all connect with the RDS **master** credential. That
credential owns every object in the database, so an ordinary read request runs with rights
to `DROP` the schema it is reading.

The consequence that matters most is quieter than that. **A table's owner is exempt from
row-level security** unless `FORCE ROW LEVEL SECURITY` is also set — so any RLS policy added
later would be silently bypassed by every request. The policy would exist, be reviewable, and
do nothing. Moving the runtime off the owner is what makes that layer possible at all.

## Design

| Role             | Rights                                                                                    | Used by       |
| ---------------- | ----------------------------------------------------------------------------------------- | ------------- |
| `opshub_app`     | `SELECT, INSERT, UPDATE, DELETE` on every application table; `USAGE, SELECT` on sequences | API task      |
| `opshub_worker`  | the same                                                                                  | worker task   |
| `opshub_migrate` | `ALL` on the application schemas and on `drizzle`                                         | migrator task |

No runtime role holds `CREATE`, `DROP`, `TRUNCATE` or ownership. Per-role
`statement_timeout` (30s app / 120s worker) and `idle_in_transaction_session_timeout` are set
on the roles rather than in the parameter group, so the **migrator keeps no limit** — DDL on a
large table legitimately runs for minutes, and a migration killed halfway is a far worse
failure than a slow request.

## Step 1 — create the roles (already done by `db:migrate`)

`db/migrations/0012_app_role_least_privilege.sql` creates all three roles **NOLOGIN** and
grants them. It changes the behaviour of nothing that is running: a NOLOGIN role cannot
connect, cannot be used, and cannot lock anyone out. It is idempotent and safe to re-run.

Verify:

```sql
SELECT rolname, rolcanlogin, rolsuper, rolbypassrls, rolconfig
  FROM pg_roles WHERE rolname LIKE 'opshub_%' ORDER BY 1;
```

Expect `rolcanlogin = f` for all three before cutover, and the timeouts present in
`rolconfig` for `opshub_app` and `opshub_worker`.

## Step 2 — generate and store passwords

Two secrets, one per runtime role. **`[A-Za-z0-9_-]` only and at least 24 characters** — the
enable script refuses anything else. The charset restriction sidesteps URL-encoding questions
entirely, since `db/database-url.ts` composes a DSN from discrete parts.

```bash
for role in app worker; do
  aws secretsmanager create-secret \
    --name "opshub/<env>/db-${role}-password" \
    --secret-string "$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9_-' | head -c 40)"
done
```

## Step 3 — grant LOGIN and verify

`db/enable-least-privilege-roles.ts` grants LOGIN **and proves the role is neither
over- nor under-privileged**. It is the same script CI runs before its e2e job, so the code
path exercised here is the one production uses.

It runs as a one-off task on the **migrator** task definition — the only workload holding the
master credential and sitting in the database's subnets. RDS is not publicly accessible and
ECS Exec is off, so there is no other path in.

```bash
aws ecs run-task \
  --cluster opshub-<env> \
  --task-definition opshub-<env>-migrator \
  --network-configuration "awsvpcConfiguration={subnets=[...],securityGroups=[...]}" \
  --overrides '{"containerOverrides":[{
    "name":"migrator",
    "command":["node","dist/db/enable-least-privilege-roles.js"],
    "environment":[
      {"name":"DATABASE_APP_PASSWORD","value":"..."},
      {"name":"DATABASE_WORKER_PASSWORD","value":"..."}
    ]}]}'
```

Prefer `secrets` over `environment` for the two passwords so they never appear in the task
definition or in CloudTrail.

Every check it performs, and what each one catches:

| Check                                                                       | Catches                                                                              |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| role exists                                                                 | migration 0012 never ran against this database                                       |
| `rolcanlogin` after `ALTER ROLE`                                            | the `ALTER` silently did nothing                                                     |
| no `rolsuper`/`rolbypassrls`/`rolcreatedb`/`rolcreaterole`/`rolreplication` | a role that **looks** restricted but is worse than the master credential it replaces |
| all four DML privileges on **every** table in all 14 schemas                | a table or whole schema the grants missed — invisible until a request touches it     |
| `SELECT` on a real table succeeds                                           | a role so restricted it cannot serve any request                                     |
| `CREATE TABLE` **fails**                                                    | grants widened to ownership, making the split decorative                             |

The DDL probe runs inside a transaction that always rolls back, so a failure part-way cannot
leave a stray table in a real schema.

## Step 4 — point the workloads at the new roles

Two infra variables, in this order, **one deploy apart**:

1. `db_role_passwords_set = true` — creates the Secrets Manager entries and wires them, while
   api/worker still use the master credential. Nothing changes behaviourally.
2. `db_least_privilege = true` — switches `DATABASE_USER`/`DATABASE_PASSWORD` on the api and
   worker tasks to `opshub_app` / `opshub_worker`. The migrator keeps the master credential.

Splitting the two means the secrets exist and are readable _before_ anything depends on them,
so a permissions problem on the secret surfaces as a failed plan rather than a task that
cannot boot.

## Rollback

Set `db_least_privilege = false` and deploy. The api and worker return to the master
credential immediately; the roles stay in place, unused. Nothing needs to be dropped and no
migration needs reverting.

## What is deliberately NOT done yet

**Ownership transfer.** The master role still owns every object. Until ownership moves to
`opshub_migrate`, `ALTER DEFAULT PRIVILEGES … FOR ROLE opshub_migrate` cannot be set from the
migration — Postgres only allows setting another role's default privileges with ADMIN OPTION
on it, and whether the master user holds that depends on who created the role. rally hit
exactly this: the statement's success varied by environment and a
`permission denied to change default privileges` aborted the whole migration, breaking a
develop deploy. It also buys nothing while `opshub_migrate` is NOLOGIN and creates no objects.

Do it in the migration that transfers ownership, which necessarily runs as (or as a member of)
`opshub_migrate` and can set them without any membership gymnastics.

**`FORCE ROW LEVEL SECURITY`.** The point of this work is to make RLS possible; adding
policies is separate, and worth doing only once the runtime provably runs as a non-owner —
which step 3's exhaustive check and the CI e2e run establish.

## Local development

Nothing to do. The local stack connects as the `opshub` superuser, and migration 0012's roles
sit unused. To reproduce the CI split locally:

```bash
DATABASE_MIGRATION_URL='postgres://opshub:opshub@localhost:5410/opshub' \
DATABASE_APP_PASSWORD='local-opshub-app-least-privilege' \
  pnpm db:roles:enable

DATABASE_URL='postgres://opshub_app:local-opshub-app-least-privilege@localhost:5410/opshub' \
DATABASE_MIGRATION_URL='postgres://opshub:opshub@localhost:5410/opshub' \
  pnpm test:e2e
```

The e2e `globalSetup` truncates and re-seeds, which needs the owner, so it reads
`DATABASE_MIGRATION_URL` while the application reads `DATABASE_URL`.
