# The "OpsHub Graph Worker" Entra app

The one Entra app registration opshub uses to call Microsoft Graph with **application** permissions.
This is its specification; the code that uses it is `libs/modules/graph`.

**Status: specified, not yet created.** opshub has no users and moves on-prem soon, so the app is created
at the on-prem move (dev first, prod later), with a federated credential and no secret. Until then
`GRAPH_CLIENT_ID` is unset and every Graph feature skips (see _Off_ below). The sign-in app ("OpsHub Dev"
and its prod twin) holds **no application permissions**.

## Why a separate app

|                               | Sign-in app (`ENTRA_CLIENT_ID`)          | Graph worker app (`GRAPH_CLIENT_ID`)                                                  |
| ----------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------- |
| Used by                       | API (BFF login callback)                 | **Worker only**                                                                       |
| Flow                          | Authorization code + PKCE (delegated)    | Client credentials (application)                                                      |
| Permissions                   | `openid`, `profile`, `email` (delegated) | The five below (application)                                                          |
| Credential                    | Client secret (`ENTRA_CLIENT_SECRET`)    | **Certificate now, federated token later. No secret.**                                |
| If the process is compromised | A session-minting secret leaks           | The API has nothing to steal; the worker's credential is short-lived or a private key |

Before this split one registration held both, with application permissions that included a directory
role-management write (the app could have made itself Global Admin) and `User.ReadWrite.All`. The API
task had the Graph secret injected. Now the API process has no Graph variable, no Graph client and cannot
import the module that has one — `test/graph-client-single-source.spec.ts` fails the build if it does.

## Application permissions — exactly these five, admin-consented

| Permission                                | Used by                                                   | Call                                                                         | Why this and not a broader one                                                                                                                                                                                                   |
| ----------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SecurityEvents.Read.All`                 | `SecureScoreSyncService` (`secure-score-sync.service.ts`) | `GET /security/secureScores`, `GET /security/secureScoreControlProfiles`     | Least privileged for `secureScore` per Microsoft; `…ReadWrite.All` is the higher one. (Control profiles: same family; confirm on first run.)                                                                                     |
| `DeviceManagementManagedDevices.Read.All` | `DeviceSyncService`, `ShadowItScanService`                | `GET /deviceManagement/managedDevices`, `GET /deviceManagement/detectedApps` | Least privileged for both; `…ReadWrite.All` can wipe and retire devices.                                                                                                                                                         |
| `User.EnableDisableAccount.All`           | `EntraAccountService.setEnabled`                          | `PATCH /users/{id}` `{ accountEnabled }`                                     | Microsoft names `User.EnableDisableAccount.All` + `User.Read.All` the least-privileged pair for `accountEnabled`. `User.ReadWrite.All` also edits names, phones, licences.                                                       |
| `User.Read.All`                           | same                                                      | same                                                                         | Required alongside the above for that call.                                                                                                                                                                                      |
| `User.RevokeSessions.All`                 | `EntraAccountService.revokeSessions`                      | `POST /users/{id}/revokeSignInSessions`                                      | The only application permission that grants it. Disabling an account stops _new_ sign-ins; revoking ends the refresh tokens already issued. It does not apply to external (guest) users — their home tenant owns their sessions. |

Verify after consent: decode an access token for the app and check the `roles` claim lists exactly these
five values, nothing else.

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

| Trigger                              | What the API does                                                                                         | What the worker does                                                     |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Offboarding approved                 | Queues `entra.account.set_enabled(false)` then `entra.sessions.revoke`, **in the approval's transaction** | Runs them in order; 30 s doubling backoff, 5 attempts, then dead-letters |
| Onboarding approved (final step)     | Queues `entra.account.set_enabled(true)`, same transaction                                                | Same                                                                     |
| `POST /v1/compliance/shadow-it/scan` | Queues `compliance.shadow_it.scan` (deduped), returns **202**                                             | Walks `detectedApps`                                                     |
| `POST /v1/security-posture/sync`     | Queues `security.posture.sync` (deduped), returns **202**                                                 | Secure Score + baseline controls                                         |
| Schedule                             | —                                                                                                         | Device sync every 30 min, shadow-IT every 6 h, posture daily 02:00 UTC   |

Tasks live in `messaging.graph_task_outbox`. The Intune device sync resumes from
`messaging.graph_sync_state` (the newest `lastSyncDateTime` seen), not from an in-memory link: the
`managedDevices/delta` endpoint it used to call is not a documented method of the v1.0 managedDevice
resource, so it lists with a `lastSyncDateTime` filter instead.

## Known limits and follow-ups

- The worker still receives `ENTRA_CLIENT_SECRET`: the env schema is shared by both processes. A
  worker-specific schema removes it.
- The api task's ECS _execution_ role can still read every secret in the stack's bundle, including
  `graph-client-certificate` (the application process cannot — only the ECS agent uses the execution
  role). Scope `secret_iam_arns` per service to close that on ECS; it disappears with External Secrets on
  k3s.
- A shadow-IT scan or posture sync runs inside the relay's transaction and can hold it for minutes. Safe
  (row-level lock, one relay pass at a time), but if scans grow, give long tasks their own relay.
- Not verified here (no tenant access): the `secureScoreControlProfiles` least-privilege row, and
  `$filter=lastSyncDateTime ge …` against a live Intune tenant. Check both on the first run and record the
  result here.
