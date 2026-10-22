# The "OpsHub Graph Worker" Entra app

The one Entra app registration opshub uses to call Microsoft Graph with **application** permissions.
This is its specification; the code that uses it is `libs/modules/graph`.

**Status: wired — the worker code in `libs/modules/graph` is done; the Entra app registration itself is created** at the on-prem move
at the on-prem move (dev first, prod later), with a federated credential and no secret. Until then
`GRAPH_CLIENT_ID` is unset and every Graph feature skips (see _Off_ below). The sign-in app ("OpsHub Dev"
and its prod twin) holds **no application permissions**.

## Why a separate app

|                               | Sign-in app (`ENTRA_CLIENT_ID`)          | Graph worker app (`GRAPH_CLIENT_ID`)                                                  |
| ----------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------- |
| Used by                       | API (BFF login callback)                 | **Worker only**                                                                       |
| Flow                          | Authorization code + PKCE (delegated)    | Client credentials (application)                                                      |
| Permissions                   | `openid`, `profile`, `email` (delegated) | Three or five below (application), by environment                                     |
| Credential                    | Client secret (`ENTRA_CLIENT_SECRET`)    | **Certificate now, federated token later. No secret.**                                |
| If the process is compromised | A session-minting secret leaks           | The API has nothing to steal; the worker's credential is short-lived or a private key |

Before this split one registration held both, with application permissions that included a directory
role-management write (the app could have made itself Global Admin) and `User.ReadWrite.All`. The API
task had the Graph secret injected. Now the API process has no Graph variable, no Graph client and cannot
import the module that has one — `test/graph-client-single-source.spec.ts` fails the build if it does.

## Accepted risk: mail shares this app

Outbound email is sent by this same app (certificate, worker only; the Exchange RBAC role `Application Mail.Send` scoped to one mailbox, and **no** `Mail.*` in Entra,
see `docs/runbooks/mail-graph.md`). That is the organisation's standard, one Service app per product and environment, and it was a conscious choice, but the
consequence should be stated: **one certificate now covers both the permissions below (Intune reads, account disable and session revocation) and sending as
the shared mailbox.** Whoever holds that certificate, or the worker's execution role that injects it, can do both. The mitigations are the ones that already
bound the app: the certificate lives in one Secrets Manager secret readable only by the worker's execution role (not by the API and not by any task role), there
is no client secret, the Exchange scope limits mail to one `PrimarySmtpAddress`, and develop and production are separate apps with separate certificates. If
mail ever needs a different blast radius from the directory actions, the split is a second Service app and a second certificate; nothing in the code assumes one.

## Application permissions — admin-consented: three in develop, five in production

**Production** holds all five rows below. **Develop holds ONLY the three read permissions** (`SecurityEvents.Read.All`, `DeviceManagementManagedDevices.Read.All`, `User.Read.All`), because develop shares the real tenant and must not be able to disable or sign out a real account. With `User.EnableDisableAccount.All` and `User.RevokeSessions.All` absent, `EntraAccountService` fails closed: Graph answers 403, nothing is changed, one clear error is logged naming the missing permission, and the task dead-letters (alarm) instead of retrying.

| Permission                                | Used by                                                   | Call                                                                              | Why this and not a broader one                                                                                                                                                                                                   |
| ----------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SecurityEvents.Read.All`                 | `SecureScoreSyncService` (`secure-score-sync.service.ts`) | `GET /security/secureScores`, `GET /security/secureScoreControlProfiles`          | Least privileged for `secureScore` per Microsoft; `…ReadWrite.All` is the higher one. (Control profiles: same family; confirm on first run.)                                                                                     |
| `DeviceManagementManagedDevices.Read.All` | `DeviceSyncService`, `ShadowItScanService`                | `GET /deviceManagement/managedDevices`, `GET /deviceManagement/detectedApps`      | Least privileged for both; `…ReadWrite.All` can wipe and retire devices.                                                                                                                                                         |
| `User.EnableDisableAccount.All`           | `EntraAccountService.setEnabled`                          | `PATCH /users/{id}` `{ accountEnabled }`                                          | Microsoft names `User.EnableDisableAccount.All` + `User.Read.All` the least-privileged pair for `accountEnabled`. `User.ReadWrite.All` also edits names, phones, licences.                                                       |
| `User.Read.All`                           | `EntraAccountService.assertBelongsTo`, `setEnabled`       | `GET /users/{id}?$select=id,userPrincipalName,mail,proxyAddresses`, and the above | The identity check before any change reads the object; also required alongside `User.EnableDisableAccount.All` for the `PATCH`.                                                                                                  |
| `User.RevokeSessions.All`                 | `EntraAccountService.revokeSessions`                      | `POST /users/{id}/revokeSignInSessions`                                           | The only application permission that grants it. Disabling an account stops _new_ sign-ins; revoking ends the refresh tokens already issued. It does not apply to external (guest) users — their home tenant owns their sessions. |

Verify after consent: decode an access token for the app and check the `roles` claim lists exactly the values for that environment (three in develop, five in production), nothing else. `platform-mail-check --allowed-role …` does this (`docs/runbooks/mail-graph.md`, step 8).

### Mail

This app also **sends the product's email**, with no Graph permission at all: its only mail authority is the Exchange Online RBAC role
"Application Mail.Send", scoped to one shared mailbox per environment (`noreply-opshub-dev@qnsc.vn` for develop, `noreply-opshub@qnsc.vn` for production).
Entra grants and Exchange grants are additive, so a `Mail.*` permission here would make that scope meaningless. Setup and proof:
[`docs/runbooks/mail-graph.md`](runbooks/mail-graph.md). Same credential, same worker; `EMAIL_PROVIDER=graph`.

### Never grant

- **`RoleManagement.ReadWrite.Directory`** and the rest of the directory role-management write family
  (tenant-takeover level). The PIM client that needed it had no caller and was deleted. If elevating
  directory roles from opshub is ever wanted, redesign it: keep the approval in opshub and have the
  approver activate the role in PIM, or give a separate human-gated process a narrowly scoped role. Do not
  put it on an unattended app. A ratchet test fails the build if any source file references it.
- `User.ReadWrite.All`, `Directory.ReadWrite.All`, `Application.ReadWrite.All`,
  `AppRoleAssignment.ReadWrite.All`, `Mail.*`, `Files.*` — nothing in opshub calls them.

### What the permissions cannot do

An application token can disable an ordinary account. For an account that holds a directory role, Entra
refuses an app without a role of its own (expect a 403); that is a feature — offboarding an administrator
is done by a human. The task dead-letters with the 403 in `last_error` and pages through the outbox
dead-letter alarm.

**Disabling or revoking a user who holds a privileged directory role returns 403 under these permissions
and dead-letters. That is a manual IT step, by design:** the offboarding in opshub completes, the alarm
fires, and IT disables the account and revokes its sessions in the Entra portal. Do not "fix" it by
granting the app a directory role.

### Which directory object a task may act on

A task names an employee; the object is whatever `employees.entra_oid` holds. Before any change the
worker reads that object and requires its `mail`, `userPrincipalName` or one of its `smtp:` proxy
addresses (prefix stripped, case-insensitive) to equal the employee's email, and dead-letters otherwise.
That stops a wrong or one-sided `entra_oid`. It does not stop someone who can write **both** the email and
the `entra_oid` (`employee.write`) from pointing an employee at a directory object that has no employee
row of its own; Microsoft's own limit on privileged roles, and the audit trail, bound that. Treat
`employee.write` accordingly. Emails are stored lower-cased and trimmed and are unique case-insensitively
(`uq_employee_email_lower`). Migration 0035 lower-cases the existing rows (after refusing, with the
addresses named, if two would collide), and every lookup compares `lower(email)`, so an employee created
before this change still matches at their first SSO login.

## Credential

Both are interchangeable behind `TokenCredential` (`graph-credential.ts`); moving from ECS to k3s is
configuration only. If both are set, **federated wins**.

### Now, on ECS — a certificate

1. Generate a key and a certificate (the app only needs the public half uploaded):
   ```sh
   openssl req -x509 -newkey rsa:3072 -nodes -days 365 -subj "/CN=opshub-graph-worker" \
     -keyout graph-worker.key -out graph-worker.crt
   cat graph-worker.key graph-worker.crt > graph-worker.pem
   ```
2. Upload `graph-worker.crt` under _Certificates & secrets → Certificates_ of the app. Do **not** create a
   client secret.
3. Put `graph-worker.pem` (key + certificate; raw or base64) in the Secrets Manager secret
   `graph-client-certificate`; delete the local files.
4. Set `graph_client_id` (the app's client id — public) and `graph_client_certificate_set = true`. The
   stack injects `GRAPH_CLIENT_ID` and `GRAPH_CLIENT_CERTIFICATE` into the **worker task only**.
5. Rotate before expiry: add the new certificate, update the secret, redeploy the worker, remove the old
   certificate.

### Later, on k3s — a federated identity credential (no secret, no certificate)

Add a **federated credential** to the same app (OpenTofu, `azuread_application_federated_identity_credential`):

| Field    | Value                                                                                                                                                                   |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Issuer   | The cluster's service-account issuer, `https://oidc.<domain>/onprem` (HYBRID-INFRA-PLAN §7.1) — one credential per cluster, so dev and prod apps trust their own issuer |
| Subject  | `system:serviceaccount:opshub:worker` — the `opshub` namespace and the chart's `worker` ServiceAccount (the chart names the ServiceAccount after the service)           |
| Audience | `api://AzureADTokenExchange`                                                                                                                                            |

Mount a projected ServiceAccount token with that audience into the worker pod and set
`GRAPH_FEDERATED_TOKEN_FILE` to its path (Azure Workload Identity's webhook uses
`/var/run/secrets/azure/tokens/azure-identity-token`). Then remove the certificate and unset
`GRAPH_CLIENT_CERTIFICATE`. The API pod gets neither the token mount nor the variable.

## Configuration

| Variable                     | Read by | Meaning                                               |
| ---------------------------- | ------- | ----------------------------------------------------- |
| `ENTRA_TENANT_ID`            | worker  | The directory (shared with sign-in)                   |
| `GRAPH_CLIENT_ID`            | worker  | **The on/off switch.** Unset = Graph off              |
| `GRAPH_CLIENT_CERTIFICATE`   | worker  | PEM, key + certificate (ECS)                          |
| `GRAPH_FEDERATED_TOKEN_FILE` | worker  | Projected token path (k3s); wins over the certificate |

## Off

With `GRAPH_CLIENT_ID` unset (or no credential), `GraphClientService.isEnabled()` is false and says so
**once**, at info. The scheduled syncs return immediately. **Queued tasks wait**: the relay claims nothing
while Graph is off, so an offboarding approved before the app exists disables the account the day the app
does, instead of being dropped. No 403 per cron tick.

## How the API asks for Graph work

| Trigger                              | What the API does                                                                                               | What the worker does                                                                                                     |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Offboarding or onboarding approved   | Queues `entra.account.reconcile` `{ employeeId }` **in the approval's transaction**                             | Reads the employee's _current_ status and Entra id, sets the account to match, one task per employee at a time, in order |
| `POST /v1/compliance/shadow-it/scan` | `409 GRAPH_DISABLED` if no worker with Graph is up, else queues `compliance.shadow_it.scan` and answers **202** | Walks `detectedApps` under the cron's lock                                                                               |
| `POST /v1/security-posture/sync`     | Same, `security.posture.sync`                                                                                   | Secure Score + baseline controls under the cron's lock                                                                   |
| Schedule                             | —                                                                                                               | Device sync every 30 min, shadow-IT every 6 h, posture daily 02:00 UTC                                                   |

**Level-triggered, never carrying a directory object.** An account task names an _employee_, never an
Entra object id and never "enable" or "disable". The worker decides from the database when it runs:
`offboarded` => disable and revoke sign-in sessions; otherwise => enable, re-reading the status
immediately before the enable and skipping it if the employee was offboarded in the meantime. A stale
"enable" queued at onboarding therefore cannot re-enable someone since offboarded. Tasks for one employee
never overlap (see _Ordering_).

**What this does and does not guarantee about which account is touched.** The API cannot put a directory
object in a task. But the object acted on is whatever `employees.entra_oid` holds, and that column is
writable through `POST /employees` (by a holder of `employee.write`; the value is validated as a GUID) and
by SSO linking. So the worker VERIFIES before any change:
`GET /users/{oid}?$select=id,userPrincipalName,mail,proxyAddresses` must return a `mail`, a
`userPrincipalName` or an `smtp:` proxy address equal to the employee's email (case-insensitive). If not, the
task dead-letters (alarm), nothing is changed, and the failure message names neither address. The
`entra_oid` must also be a GUID and is URL-encoded.

**Calls cannot outlive their lease.** The SDK's default retry loop is removed (the relay is the only
retry) and every request carries a hard 30 s deadline that **starts before the access token is requested**
(the timeout is the first handler in the chain, so a stalled token fetch is inside it; a token that
arrives after the deadline meets an aborted signal and nothing is sent). Before each change (PATCH,
revoke) the task also checks that at least one full call deadline plus a margin of its lease remains, and
otherwise steps aside (attempt refunded) rather than start a call that could land after a takeover. Each task kind declares its maximum
number of calls (`GRAPH_TASK_MAX_CALLS`: 3 for an account task, 2 for posture, a 100-page cap for a scan)
and its lease is `maxCalls x 30 s + 60 s` (150 s, 120 s, 51 min). A test asserts the inequality for every
kind. Without it: worker A's throttled enable retries inside the SDK past its lease, worker B re-claims,
reads "offboarded" and disables, and A's late PATCH re-enables the account with nothing to put it right.
The email relay is bounded the same way (a 30 s send deadline, SES cancelled by `abortSignal`, lease
90 s).

**Two relays, so a scan never delays an offboarding.** Account tasks and scans/syncs are claimed by
separate relays (`GraphAccountRelayService`: batches of 3, 150 s leases; `GraphScanRelayService`: one at a
time, long lease), each its own claim and its own in-flight pass. An offboarding disable runs while a
scan is still going, and a worker that crashes holding a scan strands that scan alone.

**Batches are held for the sum of their leases.** A relay works its batch one row after another, so the
claim holds the whole batch for the SUM of the rows' leases (otherwise a late row's lease lapses while it
waits, another relay re-claims it, and an attempt is burned). A worker that dies holding a batch therefore
strands it for `batch x lease`; batches are small (account 3 x 150 s, email 5 x 90 s, webhook 5 x 2 min,
notification 10 x 60 s) and a pass keeps claiming until the queue is empty, so that costs no throughput.
`test/outbox-batch-hold.spec.ts` caps it at 15 minutes.

**Ordering.** A task is claimable only while no other task for the employee is earlier and pending, or
holds a live lease (commit order can differ from `seq` order). Under READ COMMITTED two claims running at
once cannot see each other's uncommitted leases, so every claim first takes
`pg_advisory_xact_lock` in a statement _before_ its SELECT and holds it to commit; a second claim waits
and its SELECT then sees the first one's leases. The live-lease guard stays as the rule; the lock makes it
reliable.

**A held cron lock defers, it does not complete.** A queued scan or sync takes the same `ExclusiveJob` lock
as the cron. If the lock is held — possibly by a crashed run, whose lock lives for hours — the row stays
pending with the attempt refunded and retries in 5 minutes (each defer is logged at warn); it is never
marked done. Deferring is bounded: a request older than the lock's TTL plus 10 minutes has outlived any
run that could legitimately hold the lock, so it dead-letters (alarm) instead of waiting for ever.

**No transaction across a Graph call (lease-and-fence).** Every outbox relay (email, notifications,
webhooks and these tasks) claims rows in a short transaction (`attempts + 1`, a fresh `lease_token`,
`locked_until`), calls out with **no transaction open**, and finishes in a new one fenced on the token. A
scan can run for as long as its lease without holding a database session, and a relay whose lease lapsed
cannot overwrite the one that took over. The attempt is spent at claim time, so a process that dies
mid-call still uses up its budget; a row whose lease lapsed with every attempt used is dead-lettered
("abandoned") by the next claim.

**Failures are classified.** 400/403/404 from Graph dead-letter at once (a missing permission or a
deleted user does not heal); 429/503/504 honour `Retry-After`, clamped to one hour and ignored if it is
negative, non-finite or malformed (a hostile `1e13` must not park an employee's offboarding behind it);
everything else uses the 30 s doubling backoff, five attempts, then the `outboxDeadLetter` alarm.

**Availability is reported, not assumed.** Each worker replica writes `enabled` or `disabled` to its own
row in `messaging.graph_sync_state` every 30 s. The two 202 endpoints answer `409 GRAPH_DISABLED` unless
ANY replica has a fresh `enabled` heartbeat, so the UI never promises a scan nobody can run. Account tasks ignore it: an
approved offboarding queues regardless and waits for the app.

The Intune device sync lists all managed devices with a plain `$select` (no `$filter`, no delta — neither
is a documented feature of that resource), compares `lastSyncDateTime` client-side against a cursor kept
in `graph_sync_state`, evaluates every device in a daily full pass, raises a finding for any device silent
for 30 days, and does not let one device's failure end the pass or advance the cursor past it. A finding is
not re-raised while one with the same source is still live (open, acknowledged or risk-accepted); once it is
resolved, the condition returning raises a new one.

## Configuration by process

The environment schema is split by role (`libs/platform/src/config/env.schema.ts`); each process declares
its role first (`apps/<app>/src/role.ts`) and **refuses to start** with a variable it must not hold, naming
the variable and never its value.

| Variable                                                                    | API                  | Worker               |
| --------------------------------------------------------------------------- | -------------------- | -------------------- |
| `ENTRA_CLIENT_SECRET` (sign-in)                                             | holds it             | **refuses to start** |
| `GRAPH_CLIENT_ID`, `GRAPH_CLIENT_CERTIFICATE`, `GRAPH_FEDERATED_TOKEN_FILE` | **refuses to start** | holds them           |

The types follow: `ApiConfigService.get('GRAPH_CLIENT_ID')` and `WorkerConfigService.get('ENTRA_CLIENT_SECRET')`
do not compile. In Terraform the sign-in secret is injected into the API alone (`api_secrets`), and the
Graph certificate is a **standalone** `aws_secretsmanager_secret` — not a key in the `opshub/<env>/app`
bundle, whose ARN the API and migrator execution roles are granted — granted to the worker's execution
role only.

## Known limits and follow-ups

- The API and the migrator cannot read the Graph certificate. On k3s, with a federated credential, there is
  no secret to scope at all.
- A device finding raised for non-compliance, encryption or staleness is not closed automatically when the
  device recovers; resolve it in the compliance screen.
- Not verified here (no tenant access): the `secureScoreControlProfiles` least-privilege row, and the list
  call against a live Intune tenant. Check both on the first run and record the result here.
