# Runbook — turn Microsoft Graph on

## What this does and when

opshub ships with Graph **off**. Nothing is broken while it is off: Intune device sync, the shadow-IT
scan, Secure Score and the posture sync skip with one info log, the two `202` endpoints answer
`409 GRAPH_DISABLED`, and **Entra account disable/enable and session revoke wait in
`messaging.graph_task_outbox`** — an offboarding approved today is carried out the day Graph is switched on.

This runbook creates the worker-only Entra app **OpsHub Graph Worker**, gives it its credential, points the
worker at it and checks that it works. The app's specification (why each permission, what it cannot do) is
[`docs/graph-worker-app.md`](../graph-worker-app.md); read its _Never grant_ and _What the permissions
cannot do_ sections first.

You need:

- an Entra role that can **create an app registration and grant admin consent for Microsoft Graph application
  permissions**: Global Administrator or Privileged Role Administrator. (Application/Cloud Application
  Administrator can create the app but **cannot** consent to Graph application permissions.)
- AWS access to the QNSC account with a role that can write the secret and merge infra (`qnsc-admin`).
- `az` (Azure CLI), `openssl`, `jq`, `aws`.

One registration **per environment**: develop first, production later, each with its own credential. Do the
whole runbook for develop, check it, then repeat it for prod with `env=prod` and prod's `infra/live/prod`.

**Leftover from before the split: the `graph-client-secret` key of the `opshub/<env>/app` secret.** The
previous setup kept the Graph client secret as a key inside that shared bundle, which the API and migrator
roles can read. The task definitions no longer reference it (the 2026-10-12 apply removed the reference), but
Terraform does not manage the bundle's contents, so the value stayed. **The owner is removing that key now.**
This runbook does not depend on it and never reads it. When it is gone, also delete the client secret on the
old, over-privileged registration (the one that held `RoleManagement.ReadWrite.Directory` and
`User.ReadWrite.All`): a secret that is no longer stored anywhere should not stay valid in Entra.

Order matters in exactly one place, and getting it wrong takes the worker down: **the secret must hold a
value before `graph_client_certificate_set` is flipped** (Part 4). ECS cannot start a task whose injected
secret has no value (`ResourceInitializationError … can't find the specified secret value for staging label:
AWSCURRENT`), and a worker that cannot start does not run any other cron either.

---

## Part 1 — create the app (once per environment)

Work in a scratch shell. Nothing here is secret: an application id is public.

```sh
az login --tenant "$ENTRA_TENANT_ID" --allow-no-subscriptions

# Single tenant, no redirect URI, no implicit grant, no delegated permission: this app is never signed in to.
APP_ID=$(az ad app create \
  --display-name "OpsHub Graph Worker" \
  --sign-in-audience AzureADMyOrg \
  --query appId -o tsv)
echo "$APP_ID"
az ad sp create --id "$APP_ID" >/dev/null     # the enterprise application (service principal)
```

### Owners: none

Creating an app can add you as its owner. An owner can add a credential to the app and so act as it, which
is the very thing this app's narrow permissions exist to prevent. Remove every owner of **both** the
registration and the service principal:

```sh
for id in $(az ad app owner list --id "$APP_ID" --query '[].id' -o tsv); do
  az ad app owner remove --id "$APP_ID" --owner-object-id "$id"
done
SP_OID=$(az ad sp show --id "$APP_ID" --query id -o tsv)
for id in $(az ad sp owner list --id "$SP_OID" --query '[].id' -o tsv); do
  az ad sp owner remove --id "$SP_OID" --owner-object-id "$id"
done

# Both must print []
az ad app owner list --id "$APP_ID" --query '[].userPrincipalName'
az ad sp  owner list --id "$SP_OID" --query '[].userPrincipalName'
```

(Removing the last owner is allowed. From now on the app is changed only by a Global/Application
Administrator, which is a roster you already audit.)

### Permissions: exactly five, application, admin-consented

The role ids are looked up by **name** from Graph's own service principal, so a stale id cannot grant the
wrong permission:

```sh
GRAPH_API=00000003-0000-0000-c000-000000000000     # Microsoft Graph
for perm in \
  User.Read.All \
  User.EnableDisableAccount.All \
  User.RevokeSessions.All \
  DeviceManagementManagedDevices.Read.All \
  SecurityEvents.Read.All
do
  role_id=$(az ad sp show --id "$GRAPH_API" \
    --query "appRoles[?value=='$perm' && contains(allowedMemberTypes,'Application')].id | [0]" -o tsv)
  [ -n "$role_id" ] || { echo "no application role named $perm" >&2; exit 1; }
  az ad app permission add --id "$APP_ID" --api "$GRAPH_API" --api-permissions "$role_id=Role"
done

# Admin consent (needs the role from "You need" above). It can take a minute for the app to replicate.
sleep 30
az ad app permission admin-grant --id "$APP_ID"
```

**Verify the grant is exactly these five** — the check that matters is the _assignments on the service
principal_, not the app's requested list:

```sh
az rest --method GET \
  --url "https://graph.microsoft.com/v1.0/servicePrincipals/$SP_OID/appRoleAssignments" \
  --query "value[].appRoleId" -o tsv | sort > /tmp/granted.txt

for perm in User.Read.All User.EnableDisableAccount.All User.RevokeSessions.All \
            DeviceManagementManagedDevices.Read.All SecurityEvents.Read.All; do
  az ad sp show --id "$GRAPH_API" --query "appRoles[?value=='$perm'].id | [0]" -o tsv
done | sort > /tmp/wanted.txt

diff /tmp/wanted.txt /tmp/granted.txt && echo "exactly the five permissions"
```

The portal agrees: _Enterprise applications → OpsHub Graph Worker → Permissions_ shows five rows, all
_Application_, all _Granted for <tenant>_. If anything else is listed, remove it (`az ad app permission
delete`) and revoke its assignment before going on.

Never add: `User.ReadWrite.All`, `Directory.*`, `RoleManagement.*`, `Application.ReadWrite.All`,
`AppRoleAssignment.ReadWrite.All`, `Mail.*`, `Files.*`. A ratchet test fails the build if source references
a role-management write.

---

## Part 2 — the credential

Pick one. **No client secret is ever created for this app**, so
`az ad app show --id "$APP_ID" --query passwordCredentials` must stay `[]`.

### 2a. ECS (now): a certificate

The private key is made on **your machine**, is read by nobody else, and leaves it exactly once — into the
Secrets Manager secret `opshub/<env>/graph-client-certificate`. Only the public certificate goes to Entra.

```sh
umask 077
mkdir -p ~/graph-worker-cert && cd ~/graph-worker-cert

# 1. key + self-signed certificate (1 year; put the expiry in the team calendar)
openssl req -x509 -newkey rsa:3072 -nodes -days 365 \
  -subj "/CN=opshub-graph-worker" \
  -keyout graph-worker.key -out graph-worker.crt
cat graph-worker.key graph-worker.crt > graph-worker.pem

# 2. upload ONLY the public certificate to the app (--append keeps any existing one: this is also the
#    rotation command). This does not create a client secret.
az ad app credential reset --id "$APP_ID" --cert @graph-worker.crt --append
az ad app credential list  --id "$APP_ID" --cert -o table      # one certificate, with its end date
az ad app show --id "$APP_ID" --query passwordCredentials      # must be []
```

**Prove the app can authenticate and holds exactly the five roles — before the key is anywhere else.**
Use a throw-away Azure CLI profile so your own login is untouched:

```sh
export AZURE_CONFIG_DIR=$(mktemp -d)
az login --service-principal --username "$APP_ID" --tenant "$ENTRA_TENANT_ID" \
  --certificate graph-worker.pem --allow-no-subscriptions >/dev/null
az account get-access-token --resource-type ms-graph --query accessToken -o tsv | python3 -c '
import sys, json, base64
payload = sys.stdin.read().strip().split(".")[1]
claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
print("\n".join(sorted(claims["roles"])))'
az logout; rm -rf "$AZURE_CONFIG_DIR"; unset AZURE_CONFIG_DIR
```

The output must be exactly:

```
DeviceManagementManagedDevices.Read.All
SecurityEvents.Read.All
User.EnableDisableAccount.All
User.Read.All
User.RevokeSessions.All
```

(Claims are printed, the token is not. Do not paste a token anywhere.)

**Then put the PEM in the secret, from the file, so it never appears on a command line or in shell history:**

```sh
aws secretsmanager put-secret-value \
  --secret-id opshub/develop/graph-client-certificate \
  --secret-string file://graph-worker.pem \
  --profile qnsc-admin --region ap-southeast-1

# Confirm a version exists WITHOUT reading it (metadata only)
aws secretsmanager describe-secret --secret-id opshub/develop/graph-client-certificate \
  --query 'VersionIdsToStages' --profile qnsc-admin --region ap-southeast-1
# → {"<version-id>": ["AWSCURRENT"]}

# Delete the local copies. macOS: rm -P overwrites; Linux: shred -u.
cd ~ && rm -P graph-worker-cert/graph-worker.key graph-worker-cert/graph-worker.pem \
  graph-worker-cert/graph-worker.crt && rmdir graph-worker-cert
```

Only the secret holds the private key now. The worker's task-execution role is the only role granted
`GetSecretValue` on it (the API and the migrator are not; `infra/modules/stack/main.tf`
`worker_graph_secret_iam_arns`).

### 2b. k3s (later): a federated credential — no certificate, no secret

When the worker moves to k3s, authenticate with the cluster's service-account tokens instead of a key:
nothing to store, nothing to rotate.

```sh
cat > federated.json <<EOF
{
  "name": "opshub-worker-onprem",
  "issuer": "https://oidc.<domain>/onprem",
  "subject": "system:serviceaccount:opshub:worker",
  "audiences": ["api://AzureADTokenExchange"],
  "description": "OpsHub worker pod on the on-prem k3s cluster"
}
EOF
az ad app federated-credential create --id "$APP_ID" --parameters @federated.json
```

- `issuer` is the cluster's service-account issuer (HYBRID-INFRA-PLAN §7.1) — one credential per cluster, so
  the dev and prod apps each trust only their own cluster.
- `subject` is the `opshub` namespace and the chart's `worker` ServiceAccount. Entra matches it exactly: a
  different namespace or ServiceAccount gets `AADSTS70021`.
- Mount a projected ServiceAccount token with audience `api://AzureADTokenExchange` into the **worker pod
  only** and set `GRAPH_FEDERATED_TOKEN_FILE` to its path (Azure Workload Identity's webhook uses
  `/var/run/secrets/azure/tokens/azure-identity-token`). If both are set, **federated wins**.
- Then retire the certificate: remove the `GRAPH_CLIENT_CERTIFICATE` injection (`graph_client_certificate_set =
false`), and delete it from the app:
  ```sh
  az ad app credential list --id "$APP_ID" --cert --query '[].keyId' -o tsv
  az ad app credential delete --id "$APP_ID" --key-id <that-id>
  ```
  The `graph-client-certificate` secret can then be left empty or deleted.
- The API pod gets neither the token mount nor `GRAPH_CLIENT_ID`: it refuses to start with a `GRAPH_*`
  variable.

---

## Part 3 — point the worker at it (ECS)

`graph_client_id` is the **Graph app's** client id — not `entra_client_id`, the sign-in app, which holds no
application permissions. It is public and lives in git.

In `infra/live/develop/main.tf` (and later `infra/live/prod/main.tf`):

```hcl
  graph_client_certificate_set = true
  graph_client_id              = "<APP_ID from Part 1>"
```

Open a PR (`infra:` conventional commit). The `plan` check must show **only** the worker task definition
changing (new `GRAPH_CLIENT_ID` variable, new `GRAPH_CLIENT_CERTIFICATE` secret reference) and the worker
execution role's policy. If it shows anything on the API task definition, stop: the API must not get a
`GRAPH_*` variable. Merge; `Infrastructure · Apply` rolls the worker.

> Do this only after `describe-secret` shows `AWSCURRENT` (Part 2a). If you flipped it too early, set it back
> to `false` and re-apply; the worker recovers on the next deployment.

---

## Part 4 — verify

All read-only; none of it prints a secret.

**1. The worker started and sees Graph as on.** CloudWatch log group `/ecs/opshub-develop-worker`
(`opshub-<env_slug>-worker`). Within a minute of the new task starting:

```sh
aws logs filter-log-events --log-group-name /ecs/opshub-develop-worker \
  --start-time $(( ($(date +%s) - 900) * 1000 )) \
  --filter-pattern '"Microsoft Graph"' --profile qnsc-developer --region ap-southeast-1 \
  --query 'events[].message' --output text
```

- Present: `Microsoft Graph client initialised (certificate credential)` (logged at the first Graph call —
  the first heartbeat-driven device sync or relay pass).
- Absent: `Microsoft Graph is off (GRAPH_CLIENT_ID and a credential are not configured)`.
- No `ResourceInitializationError` on the ECS service's events (that is the empty-secret failure).

**2. The heartbeat says enabled** (read-only SQL; the owner runs it through the bastion tunnel, port 15432):

```sql
SELECT name, cursor, updated_at, now() - updated_at AS age
  FROM messaging.graph_sync_state
 WHERE name LIKE 'graph-worker-heartbeat:%'
 ORDER BY updated_at DESC;
-- cursor = 'enabled', age < 1 minute, one row per running worker task
```

**3. The two `202` endpoints answer 202, not 409**, from an authenticated session with the right
permissions:

```sh
curl -sS -o /dev/null -w '%{http_code}\n' -X POST -H "Authorization: Bearer $TOKEN" \
  -H "X-CSRF-Token: $CSRF" https://<api-domain>/v1/compliance/shadow-it/scan     # 202
curl -sS -o /dev/null -w '%{http_code}\n' -X POST -H "Authorization: Bearer $TOKEN" \
  -H "X-CSRF-Token: $CSRF" https://<api-domain>/v1/security-posture/sync         # 202
```

**4. The tasks complete.** Within a few minutes:

```sql
SELECT kind, status, attempts, left(last_error, 160) AS last_error, created_at, sent_at
  FROM messaging.graph_task_outbox
 ORDER BY seq DESC LIMIT 20;
-- status = 'sent'. Rows queued while Graph was off (e.g. an offboarding) are carried out now.
-- 'failed' = dead-lettered, and the outbox dead-letter alarm has fired: read last_error.
```

- `Graph 403` on a **scan or sync** = a permission was not consented (repeat Part 1's grant check).
- `Graph 403` on an **account** task for an administrator = by design (see below), not a fault.
- `does not belong to employee` = `employees.entra_oid` points at an object whose mail/UPN/`smtp:` alias is
  not the employee's email. Fix the employee record; do not loosen the check.

**5. Record the two things the spec says are still unverified** in
[`docs/graph-worker-app.md`](../graph-worker-app.md) _Known limits_: whether
`GET /security/secureScoreControlProfiles` works with `SecurityEvents.Read.All`, and the Intune list call
against the live tenant.

### What stays manual, by design

Disabling or revoking a user who holds a **privileged directory role** returns 403 under these permissions
and dead-letters. That is a manual IT step: disable the account and revoke its sessions in the Entra portal.
Do **not** fix it by giving the app a directory role.

---

## Rotation, rollback, and the calendar

| Event                            | What to do                                                                                                                                                                                                                                      |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Certificate expires in ≤ 30 days | Repeat Part 2a with a new key (`--append` keeps the old certificate valid), `put-secret-value`, force a new worker deployment (`aws ecs update-service --force-new-deployment`), verify Part 4, then `az ad app credential delete` the old key. |
| Suspected key exposure           | Delete the certificate from the app **first** (`az ad app credential delete`): Graph access stops at once and queued tasks wait. Then rotate as above. The sign-in app and the API are unaffected.                                              |
| Turn Graph off again             | `graph_client_id = ""` and `graph_client_certificate_set = false`, apply. Tasks queue; within a minute the heartbeat reads `disabled` and the two endpoints answer 409 again. Nothing is lost.                                                  |
| Permissions need to change       | Change `docs/graph-worker-app.md` **in the same PR** that changes the grant, with the reason. A sixth permission needs a review of what it can do, not just that the code needs it.                                                             |
