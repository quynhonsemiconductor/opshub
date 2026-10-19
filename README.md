# opshub

Internal IT/HR operations platform (**Zone B2 — internal**, not internet-exposed by default). Runs on **ECS Fargate**, per the [platform architecture](https://github.com/quynhonsemiconductor/.github/blob/main/docs/PLATFORM_ARCHITECTURE.md).

> **Monorepo.** Consolidates the former `opshub-api` + `opshub-web` + `opshub-infra` into one repository per [REPOSITORY_STRUCTURE.md](https://github.com/quynhonsemiconductor/.github/blob/main/docs/REPOSITORY_STRUCTURE.md) (ADR-R1). Old repos archived (read-only) for history.

## Layout

```
opshub/
├── apps/{api,worker,web}/   # NestJS api + worker (ECS Fargate); Vite SPA (S3+CloudFront)
├── libs/                    # shared backend libs (== design's "packages/", NestJS convention)
├── db/                      # Drizzle schema + migrations
├── deploy/ecs/              # deploy-descriptor notes (task-def is infra-owned)
├── infra/                   # OpenTofu (product-owned resources)
│   ├── live/{_shared,develop,prod}/
│   └── modules/             # LOCAL modules (see KNOWN ISSUES — dedup to qnsc-tf-modules pending)
├── .github/workflows/       # CI/CD → quynhonsemiconductor/ci
└── Dockerfile               # multi-target: api, worker, migrator
```

Workspace model, develop, build, and deploy conventions mirror [`rally`](https://github.com/quynhonsemiconductor/rally): NestJS backend is the pnpm root, `apps/web` is a workspace member; deploy is push-based to ECS via `qnsc-ci`.

## Local stack

A clean clone runs with **`cp .env.example .env` and the commands below, nothing else**. CI proves it on every PR (the `local quickstart` job boots exactly this) and `test/env-example.spec.ts` checks `.env.example` against the env schemas and the dev tooling.

**You need:** Docker with Compose v2, Node 24 (`.nvmrc`), pnpm 10 or later, and a GitHub token that can read the org's packages: the shared `@quynhonsemiconductor/*` packages install from GitHub Packages.

```bash
# Once per machine. pnpm 11+ ignores a token written in a project .npmrc (that file is committed, so an environment
# variable in it could leak to a registry the repo names), but expands one in your user-level file, on every version.
grep -qs 'npm.pkg.github.com/:_authToken' ~/.npmrc || echo '//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}' >> ~/.npmrc

export NODE_AUTH_TOKEN="$(gh auth token)"      # per shell; or a PAT with read:packages
cp .env.example .env                           # every value is already wired, secrets are local placeholders
docker compose -f docker-compose.dev.yml up -d --wait    # Postgres, Valkey, LocalStack (S3), OTel collector
pnpm install
pnpm db:migrate                                # migrations + RBAC catalogue + the demo users (SEED_ON_DEPLOY=true in .env)
```

Then one terminal per process:

```bash
pnpm start:dev          # API    → http://localhost:3001   (/livez, /readyz, /v1/*, /api/auth/*, /api/docs)
pnpm start:dev:worker   # worker → relays and cron jobs; serves no HTTP
pnpm dev:web            # SPA    → http://localhost:5173   (proxies /v1 and /api/auth to :3001)
```

Check it: `curl -s localhost:3001/readyz` answers `{"status":"ok", …, "checks":{"database":"up","cache":"up"}}` (the API's own probe), and `curl -s localhost:5173/v1/healthz` answers `ok` **through the SPA's proxy**, which is what proves Vite and the API agree on the port.

One `.env` serves both processes. Some variables belong to one of them only, and each process **refuses to start** with the other's set (a worker holding the session secret could forge a cookie). `pnpm start:dev:worker` blanks the API-only ones (`BETTER_AUTH_SECRET`, `IDENTITY_TEST_LOGIN`, `ENTRA_CLIENT_SECRET`, `EDGE_CLIENT_IP_SECRET[_PREVIOUS]`) and `pnpm start:dev` blanks the worker-only `GRAPH_*`, so you never edit the file to switch between them. `.env.example` marks every variable `[both]`, `[API]` or `[WORKER]`.

### Sign in

The login page is one "Sign in with Microsoft" button. Locally, with no Microsoft app configured, use the **test login**: `POST /api/auth/test-login {"email": …}` (loads only with `IDENTITY_TEST_LOGIN=enabled` and `NODE_ENV` `development` or `test`, so it can never exist in production). The demo users `db:migrate` seeded, one per role:

| email | role |
| --- | --- |
| `admin@opshub.local` (and `admin2` … `admin8@opshub.local`) | admin |
| `it.admin@opshub.local` | it-admin |
| `security@opshub.local` | security |
| `hr@opshub.local` | hr |
| `manager@opshub.local` | manager |
| `helpdesk@opshub.local` | helpdesk |
| `auditor@opshub.local` | auditor |
| `employee@opshub.local` | employee (holds nothing) |

**In the browser:** open http://localhost:5173, open the DevTools console and run the call from the SPA's own origin, so the session cookie lands on `localhost:5173`, then go to the app (the login page does not redirect a signed-in user by itself):

```js
await fetch('/api/auth/test-login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'admin@opshub.local' }),
}).then((r) => r.status); // 200
location.assign('/');
```

**With curl** (an API call without a browser):

```bash
curl -s -c /tmp/opshub.jar -H 'content-type: application/json' \
  -d '{"email":"admin@opshub.local"}' localhost:3001/api/auth/test-login
curl -s -b /tmp/opshub.jar localhost:3001/v1/auth/me
```

**With Microsoft (optional).** Register a **dev** app in a tenant you control, separate from production's: platform *Web*, redirect URI `http://localhost:5173/api/auth/callback/microsoft`, delegated `openid profile email` only, and a client secret. Put the tenant id, client id and secret in `.env` (`ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID`, `ENTRA_CLIENT_SECRET`) and restart the API. The signing-in account has to be on a staff domain (`qnsc.vn`) and a member of that tenant; its App Role *values* must equal OpsHub role keys (`admin`, `it-admin`, `security`, `hr`, `manager`, `helpdesk`, `auditor`), reconciled at every sign-in; no role means `employee`.

### Ports, and running beside rova

Every host port is offset from rova's defaults so both stacks run at once. The two SPAs are the exception: both want 5173.

| | opshub | rova |
| --- | --- | --- |
| API | **3001** | 3000 |
| SPA (Vite) | 5173 | 5173 |
| Postgres | **5433** | 5432 |
| Valkey | **6380** | 6379 |
| LocalStack (S3) | **4567** | 4566 |
| OTel collector (OTLP / Prometheus) | **4319** / **8890** | 4318 / 8889 |

The Vite server uses `strictPort`: a second SPA fails with "Port 5173 is already in use" instead of quietly moving to 5174, where the Microsoft sign-in redirect (`APP_URL`) and the upload bucket's CORS would no longer match. To run both SPAs, start one of them elsewhere and tell **its** API the new origin on the command line (a variable in the environment beats `.env`; `APP_URL` is the redirect and link origin, `CORS_ORIGINS` the allow-list):

```bash
APP_URL=http://localhost:5174 CORS_ORIGINS=http://localhost:5174 pnpm start:dev
pnpm dev:web --port 5174
```

(File uploads in the browser need LocalStack's bucket CORS to allow that origin too: `WEB_ORIGIN` in `scripts/localstack/01-bootstrap.sh`.)

### Run a second copy

Two checkouts, or a branch you want to keep running beside your main one, need their own compose project, host ports, and
API and web ports. Every port is bound to `127.0.0.1` and read from `.env`. In the second copy's `.env`:

1. `COMPOSE_PROJECT_NAME=opshub-2`: the containers, volumes and network take this prefix. Every checkout or worktree sets its own.
2. Give each `*_HOST_PORT` a free number: `POSTGRES_HOST_PORT`, `VALKEY_HOST_PORT`, `LOCALSTACK_HOST_PORT`, `OTEL_OTLP_HOST_PORT`, `OTEL_METRICS_HOST_PORT`.
3. Put the same Postgres, Valkey and LocalStack numbers into `DATABASE_URL`, `VALKEY_URL`, `STORAGE_ENDPOINT`, `AWS_ENDPOINT_URL`, and the OTLP port into `OTEL_EXPORTER_OTLP_ENDPOINT`. The app reads URLs, not the `*_HOST_PORT` values.
4. The API: `PORT` (the API's port; the SPA's proxy follows it).
5. The web: `WEB_DEV_PORT` (the Vite port; LocalStack's bucket CORS follows it). Then `APP_URL=http://localhost:<WEB_DEV_PORT>` and `CORS_ORIGINS=http://localhost:<WEB_DEV_PORT>`, so sign-in redirects and the API's CORS match the new origin.

For real Microsoft sign-in on the new web port, register `http://localhost:<WEB_DEV_PORT>/api/auth/callback/microsoft` as a redirect URI on your dev app; the test login needs none of this.

Then run the same commands as above. The Playwright config's `baseURL` is pinned to 5173, so `pnpm --filter opshub-web test:e2e` runs in one copy at a time.

### Useful

- `pnpm db:seed` re-runs the demo fixtures; `pnpm db:studio` opens Drizzle Studio.
- Telemetry: `docker compose -f docker-compose.dev.yml logs otel`, or `curl -s localhost:8890/metrics | grep queue_`. No collector? `OTEL_ENABLED=false` in `.env`.
- Mail is `EMAIL_PROVIDER=dev`: messages are written to the API log and not sent.
- Uploads go to LocalStack's `opshub-files-dev` bucket; `aws --endpoint-url http://localhost:4567 s3 ls s3://opshub-files-dev` (any credentials).
- Reset everything: `docker compose -f docker-compose.dev.yml down -v`, then `up -d --wait` and `pnpm db:migrate` again.
- Upgrading an existing checkout (before `name: opshub`, or from a Postgres 18 stack): the Postgres 18 volume will not start on 17 (`initdb: directory exists but is not empty`). Run `docker compose -f docker-compose.dev.yml down -v` once in that checkout; it removes only the volumes of the project that checkout runs (its `COMPOSE_PROJECT_NAME`, or `opshub`). The old containers were named `opshub-postgres`, `opshub-valkey`, `opshub-localstack` and `opshub-otel`, outside any project: remove them with `docker rm -f opshub-postgres opshub-valkey opshub-localstack opshub-otel`, or run `docker compose -p <old project dir> down -v` if you know the old project name. Do not share a project name between checkouts: `down -v` in one would wipe the other's data.
- Tests: `pnpm test` (unit), `pnpm test:e2e` (needs the stack and a migrated, seeded database), `pnpm --filter opshub-web test:e2e` (Playwright, needs the API running).

## Build status

Backend (`api` + `worker`) and web **build clean**. Consolidation is faithful (identical file counts to source); the Dockerfile now exposes the `api`/`worker`/`migrator` targets the CI expects (previously missing).

### Fixed during consolidation
- **License enums defined.** `db/schema/enums.ts` now defines `licenseTypeEnum` (`perpetual`, `subscription`, `per_seat`, `concurrent`) and `licenseStatusEnum` (`active`, `expiring_soon`, `expired`, `cancelled`) — values taken from the existing DTO Zod enums (`license.dto.ts`, the code-authoritative source). Also re-wired the `db/schema` and `@shared-kernel` barrels. Together these cleared the 17 pre-existing build errors carried from opshub-api.

### Open follow-ups (not blocking build)
1. **Generate the first Drizzle migration** for the license enums/tables (`pnpm db:generate`) before deploying the license module.
2. Stray compiled `.js`/`.js.map` files beside some `db/schema/*.ts` — clean + gitignore.

The "infra/modules/ are local copies" item is gone: every resource is a versioned `qnsc-tf-modules` ref, and `infra/modules/stack` is the local *composition* module both environments call — so develop and production cannot drift structurally, and the callers in `infra/live/<env>` hold only values.
