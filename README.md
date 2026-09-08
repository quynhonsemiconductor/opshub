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

```bash
cp .env.example .env                          # ports below are already wired in
docker compose -f docker-compose.dev.yml up -d
pnpm db:migrate                               # migrations + seed
```

Three containers, each on a port offset from rally's so both stacks can run at once: Postgres `5433`, Valkey `6380`, LocalStack `4567`. LocalStack creates the outbox queue, its DLQ and the uploads bucket on every start via `scripts/localstack/01-bootstrap.sh` — without it the outbox relay only logs events and uploads presign against a bucket that does not exist.

## Build status

Backend (`api` + `worker`) and web **build clean**. Consolidation is faithful (identical file counts to source); the Dockerfile now exposes the `api`/`worker`/`migrator` targets the CI expects (previously missing).

### Fixed during consolidation
- **License enums defined.** `db/schema/enums.ts` now defines `licenseTypeEnum` (`perpetual`, `subscription`, `per_seat`, `concurrent`) and `licenseStatusEnum` (`active`, `expiring_soon`, `expired`, `cancelled`) — values taken from the existing DTO Zod enums (`license.dto.ts`, the code-authoritative source). Also re-wired the `db/schema` and `@shared-kernel` barrels. Together these cleared the 17 pre-existing build errors carried from opshub-api.

### Open follow-ups (not blocking build)
1. **Generate the first Drizzle migration** for the license enums/tables (`pnpm db:generate`) before deploying the license module.
2. Stray compiled `.js`/`.js.map` files beside some `db/schema/*.ts` — clean + gitignore.

The "infra/modules/ are local copies" item is gone: every resource is a versioned `qnsc-tf-modules` ref, and `infra/modules/stack` is the local *composition* module both environments call — so develop and production cannot drift structurally, and the callers in `infra/live/<env>` hold only values.
