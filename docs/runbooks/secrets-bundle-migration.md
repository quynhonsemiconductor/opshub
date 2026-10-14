# Runbook — production on the secrets bundle (`opshub/production/app`)

Secrets Manager bills **$0.40 per secret per month regardless of size**. Develop (`opshub/develop/app`) and rova
(both environments) already read one JSON object, one key per value; production now does too
(`secrets_bundle_name = "app"`, `secrets_use_bundle = true` in `infra/live/prod/main.tf`).

> **DO NOT RELEASE the opshub release PR #323 (0.4.0), and do not push any `v*` tag, until #373 and #374 are merged**
> (and this PR). Both fix problems the production plan has today, and either one makes the tag's infrastructure apply
> fail or start an api task against an empty bundle:
>
> - **#373**: `module.api` created the service with a literal `desired_count = 1`, ignoring `min_count = 0`, so an api
>   task started right after the apply, against the empty bundle.
> - **#374**: production had `tunnel_enabled = false`, so the plan created `aws_lb_listener_rule` with no `listener_arn`
>   (the shared ALB is gone) and the apply fails; and production had no ingress at all.

Production has **never run a task**: the standalone secrets `opshub/production/*` were never accessed, and both
services have `min_count = 0` (with #373 the api service is created at `desired_count = 0`, like the worker). What this
runbook protects against is the first deploy failing on a bundle that is missing a key.

**Every command below is metadata-only.** A value travels through a pipe or a `0600` file in a private temp directory
and is never put in a shell variable, a command argument, or terminal output. Verification prints key names, lengths
and `match` / `MISMATCH`. Do not "check" a value by printing it.

## What is in the bundle

| key                              | read by                                 | source                                                                                             |
| -------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `cookie-secret`                  | api, worker                             | **copy** from `opshub/production/cookie-secret`                                                    |
| `csrf-secret`                    | api, worker                             | **copy** from `opshub/production/csrf-secret`                                                      |
| `entra-client-secret`            | api                                     | **copy** from `opshub/production/entra-client-secret`                                              |
| `observability-token`            | collector sidecars                      | **copy** from `opshub/production/observability-token`                                              |
| `db-app-password`                | api, once `db_least_privilege` is on    | **copy** from `opshub/production/db-app-password` (RDS `opshub-prod` already uses it)              |
| `db-worker-password`             | worker, once `db_least_privilege` is on | **copy** from `opshub/production/db-worker-password` (same)                                        |
| `better-auth-secret`             | api                                     | **NEW**: `openssl rand -base64 48` (identity 8; the standalone set has no counterpart)             |
| `edge-client-ip-secret`          | api                                     | **NEW**: `openssl rand -base64 48`, and the SAME value as the Pages secret `EDGE_CLIENT_IP_SECRET` |
| `edge-client-ip-secret-previous` | api                                     | only DURING a rotation (`edge_client_ip_secret_previous_set`); not part of this migration          |

Why these are copied and not rotated: production has never served a request, so no copy has been exposed to traffic, and
the two database passwords **must** equal what the RDS roles hold (a new value would lock the roles out). The two
values that are new (`better-auth-secret`, `edge-client-ip-secret`) have no old counterpart.

**Not copied, on purpose:** `jwt-private` (identity 8 issues no tokens; nothing reads it) and `graph-client-secret`
(Microsoft Graph authenticates with a certificate, kept in its own secret `opshub/production/graph-client-certificate`).
The apply itself removes those two standalone containers (see "What the apply does").

Until `db_least_privilege` is set in production, the task definitions read the RDS-managed master secret and **nothing
reads `db-app-password` / `db-worker-password`**. They are in the bundle now so the later cutover is not a second
migration.

## Order of events, and the one thing that cannot be done earlier

Production infrastructure applies **only on a `v*.*.*` tag** (`infra-apply.yml`); merging this PR changes nothing in
production. The bundle container is created by that apply, so it **cannot be populated before the tag's apply**. The
backend deploy of the same tag waits for the infra run, then deploys.

1. Merge #373, #374, then this PR. Nothing happens in production.
2. Push the release tag. Approve the `production` environment for **Infrastructure · Apply**. It creates
   `opshub/production/app` **empty**, the tunnel, and the services at zero tasks, and registers task definitions that
   reference the bundle's keys. The apply itself starts no task (with #373).
3. **Immediately populate and verify the bundle** (steps A to D below). The deploy that follows the apply rolls the
   services onto the new task definitions: if it gets ahead of you, its preflight (or its migrator) fails safely, the
   previous state is untouched, and the fix is to finish A to D and **re-run the failed jobs** of the tag's
   Backend · Deploy.
4. **Prove the bundle** (the gate below). Production has no ingress to probe and no running task at rest (floors are 0), so
   "a healthy deploy" cannot be the signal: the gate is D.2 + D.3 and a one-off task that reaches RUNNING.
5. Merge the follow-up PR that removes `secrets_create_standalone` (section E). The **next** tag's apply schedules the
   standalone secrets for deletion, with the 30-day recovery window. Nobody deletes anything by hand.

## A. Check the standalone sources (lengths only)

```bash
export AWS_PROFILE=qnsc-admin AWS_REGION=ap-southeast-1
for k in cookie-secret csrf-secret entra-client-secret observability-token db-app-password db-worker-password; do
  printf '%-22s ' "$k"
  aws secretsmanager get-secret-value --secret-id "opshub/production/$k" \
    --query 'length(SecretString)' --output text 2>&1 | head -c 120
  echo
done
```

Each line must be a positive number. `…can't find the specified secret value for VersionStage` means that container was
never populated: do not continue with a copy, mint it first (`cookie-secret` and `csrf-secret`: `openssl rand -base64
48`; `entra-client-secret` and `observability-token` come from Entra and Grafana Cloud; the two database passwords must
equal the roles' current passwords).

## B. The Pages secret and the new bundle values (one value, two homes)

`edge-client-ip-secret` is set on the Cloudflare Pages project `opshub-prod-web` and in the bundle, from the SAME
bytes. The value goes through a `0600` file that is deleted at the end. Run B and C in ONE fresh shell (`bash --noprofile`;
`exit` afterwards), because `set -e` would otherwise close your terminal and `$W` must survive between them.

```bash
set -euo pipefail
umask 077
W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT

openssl rand -base64 48 | tr -d '\n' > "$W/edge"
openssl rand -base64 48 | tr -d '\n' > "$W/better-auth"

# Pages: Production. wrangler reads the value from stdin when it is piped.
# (CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID in the environment.)
npx wrangler pages secret put EDGE_CLIENT_IP_SECRET --project-name opshub-prod-web < "$W/edge"
```

A Pages secret applies to **new deployments only**: the production web deploy of this tag picks it up; if it was
already deployed, redeploy the web after setting it.

## C. Build and write the bundle (still in the same shell, `$W` still exists)

```bash
{
  for k in cookie-secret csrf-secret entra-client-secret observability-token db-app-password db-worker-password; do
    aws secretsmanager get-secret-value --secret-id "opshub/production/$k" \
      --query SecretString --output text | tr -d '\n' | jq -Rs --arg k "$k" '{($k): .}'
  done
  jq -Rs --arg k edge-client-ip-secret '{($k): .}' < "$W/edge"
  jq -Rs --arg k better-auth-secret '{($k): .}' < "$W/better-auth"
} | jq -s 'add' > "$W/bundle.json"

# Key names and lengths only, before writing:
jq -r 'to_entries[] | "\(.key)\t\(.value|length)"' "$W/bundle.json" | sort

aws secretsmanager put-secret-value --secret-id opshub/production/app \
  --secret-string "file://$W/bundle.json" --query '{Name:Name,VersionId:VersionId}' --output text
rm -rf "$W"; trap - EXIT
```

`tr -d '\n'` matters: `--output text` appends a newline and the value must be byte-identical to the standalone one.

## D. Verify (names, lengths, and equality without printing)

```bash
export AWS_PROFILE=qnsc-admin AWS_REGION=ap-southeast-1
B=opshub/production/app

# 1. The bundle holds exactly the keys the stack declares (the description is generated from `secret_names`).
aws secretsmanager describe-secret --secret-id $B --query Description --output text | sed 's/.*Expected keys: //;s/\. Read per key.*//'
aws secretsmanager get-secret-value --secret-id $B --query SecretString --output text \
  | jq -r 'to_entries[] | "\(.key)\t\(.value|length)"' | sort
# Expected: the same 8 keys, every length > 0, better-auth-secret and edge-client-ip-secret >= 32.

# 2. Each copied key equals its standalone source (prints match / MISMATCH only).
for k in cookie-secret csrf-secret entra-client-secret observability-token db-app-password db-worker-password; do
  a=$(aws secretsmanager get-secret-value --secret-id "opshub/production/$k" --query SecretString --output text | tr -d '\n' | shasum -a 256 | cut -d' ' -f1)
  b=$(aws secretsmanager get-secret-value --secret-id $B --query SecretString --output text | jq -j --arg k "$k" '.[$k]' | shasum -a 256 | cut -d' ' -f1)
  [ "$a" = "$b" ] && echo "$k match" || echo "$k MISMATCH"
done

# 3. Every reference the task definitions make resolves, as ECS will: the key exists and is non-empty.
for fam in opshub-prod-api opshub-prod-worker opshub-prod-migrator; do
  aws ecs describe-task-definition --task-definition "$fam" \
    --query 'taskDefinition.containerDefinitions[].secrets[].valueFrom' --output text | tr '\t' '\n'
done | sort -u | while read -r ref; do
  case "$ref" in
    *:secret:opshub/production/app-*)
      key=$(printf '%s' "$ref" | awk -F: '{print $8}')
      n=$(aws secretsmanager get-secret-value --secret-id $B --query SecretString --output text | jq -r --arg k "$key" '.[$k]|length // 0')
      echo "bundle  $key  length=$n";;
    *) echo "other   ${ref##*:secret:}";;
  esac
done
# No `bundle … length=0`. `other` lines are the RDS-managed master secret and anything not in the bundle.
```

Step 3 closes the gap the deploy preflight leaves (qnsc-infra#191): the preflight proves the **container** is
non-empty, not that each key is in it. Run it after the apply has registered the new task definitions and before the
deploy is approved to proceed.

## The gate: prove the bundle before the standalone secrets go

Production serves nothing and keeps zero tasks at rest, so there is no healthy steady state to wait for. Two checks
stand in for it; both must pass.

1. **D.2 and D.3 above**: every copied key equals its source, and every `<bundle arn>:<key>::` reference in the api,
   worker and migrator task definitions resolves to a present, non-empty key.
2. **A one-off task reaches RUNNING.** ECS pulls every secret before the container starts, so a task that reaches
   RUNNING proves every key the api task definition references resolved and the execution role can read the bundle.
   (rova's production was proven this way.) The command is overridden so the application does not start; the
   cloudflared sidecar connects to the tunnel but nothing is routed to it.

```bash
export AWS_PROFILE=qnsc-admin AWS_REGION=ap-southeast-1
NET=$(aws ecs describe-services --cluster opshub-prod --services api --query 'services[0].networkConfiguration' --output json)
TASK=$(aws ecs run-task --cluster opshub-prod --task-definition opshub-prod-api --launch-type FARGATE \
  --network-configuration "$NET" \
  --overrides '{"containerOverrides":[{"name":"api","command":["node","-e","setTimeout(()=>{},300000)"]}]}' \
  --query 'tasks[0].taskArn' --output text)
for i in $(seq 1 30); do
  aws ecs describe-tasks --cluster opshub-prod --tasks "$TASK" --query 'tasks[0].[lastStatus,stoppedReason]' --output text
  sleep 10
done | sort | uniq -c
aws ecs stop-task --cluster opshub-prod --task "$TASK" --reason "bundle proof" --query 'task.lastStatus' --output text
```

`RUNNING` is the pass. `STOPPED` with `ResourceInitializationError … can't find the specified secret value for staging
label` (or `…:key::`) names the missing key: fix the bundle (steps C and D) and run it again. The architecture is
ARM64 (`cpu_architecture`), so an image that is not built for arm64 fails here with an unrelated message.

## E. Removing the standalone secrets (nothing is deleted by hand)

After the gate, the standalone containers are these eight: six old ones (`cookie-secret`, `csrf-secret`,
`entra-client-secret`, `observability-token`, `db-app-password`, `db-worker-password`) and two empty ones the apply
creates because `secrets_create_standalone = true` keeps the standalone set equal to the declared names
(`better-auth-secret`, `edge-client-ip-secret`).

1. A **follow-up PR** removes `secrets_create_standalone = true` from `infra/live/prod/main.tf` (the default
   `!use_bundle` is then false) and updates its comment. Merging it changes nothing in production.
2. The **next tag's** apply destroys the eight standalone containers, scheduled for deletion with the 30-day window
   (`secrets_recovery_window_days = 30`), the pattern develop and rova followed. Restore any of them inside the window
   with `aws secretsmanager restore-secret --secret-id opshub/production/<key>`.

There is no hand-delete, so there is no moment at which Terraform's state and AWS disagree and a tag must be avoided.
`jwt-private` and `graph-client-secret` are not in this set: the first apply removes them (they left the declared set
when identity 8 and the Graph certificate replaced them), with the same 30-day window.

## What the apply does (so the plan is not a surprise)

- creates `opshub/production/app` (empty), `better-auth-secret` and `edge-client-ip-secret` (empty standalone, deleted
  in step E);
- updates `entra-client-secret`'s description;
- **destroys `jwt-private` and `graph-client-secret`** (30-day recovery);
- re-registers the api, worker and migrator task definitions with `<bundle arn>:<key>::` references, and rewrites each
  execution role's `secretsmanager:GetSecretValue` grant to cover the bundle, the retained standalone secrets and the RDS
  master secret while both sets exist; it narrows to the bundle plus the RDS master secret only after the follow-up
  (section E) has been applied;
- the rest of the production plan (ECS services at zero tasks, the Cloudflare tunnel and its connector token, DNS,
  dashboard, alerts) is infrastructure production never had; it comes from #373 and #374 and main, not from this change.

## Rolling back

Before the follow-up's apply: set `secrets_use_bundle = false` in `infra/live/prod/main.tf`, apply on a tag, redeploy. The standalone
secrets still hold their values (`better-auth-secret` and `edge-client-ip-secret` must then be populated by hand: they
are new). After the follow-up's apply (section E): restore within the 30-day window, or recreate and re-paste by hand. **The bundle is then the only copy of
`better-auth-secret` and `edge-client-ip-secret`**; do not delete it casually, and keep the Pages secret in step with it.

## What bundling gives up

IAM cannot scope below a secret, so a bundle is granted whole: the execution role that reads one key can read all of
them. Accepted because the api execution role already reads the whole set. Keep a value out of the bundle if it needs
its own resource policy or rotation (the Graph certificate stays standalone for that reason).
