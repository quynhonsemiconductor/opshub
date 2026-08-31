import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import * as schema from '../../../../db/schema';
import { pgOptions } from '../../../../db/pg-ssl';
import { resolveDatabaseUrl } from '../../../../db/database-url';

export const DRIZZLE = Symbol('DRIZZLE');

export type DrizzleDB = ReturnType<typeof drizzle<typeof schema>>;
export type DrizzleTx = Parameters<Parameters<DrizzleDB['transaction']>[0]>[0];

/**
 * A database executor — either the root connection or an open transaction.
 * Repositories accept an optional executor so they can enlist in a caller-owned
 * transaction (Unit of Work); when omitted they fall back to the root pool.
 */
export type DbExecutor = DrizzleDB | DrizzleTx;

export const InjectDrizzle = () => Inject(DRIZZLE);

@Injectable()
export class DrizzleProvider implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DrizzleProvider.name);
  private readonly pool: Pool;
  private readonly db: DrizzleDB;

  constructor(private readonly config: AppConfigService) {
    this.pool = new Pool({
      // Composed from DATABASE_* parts when no complete URL is supplied, so the
      // deployed path reads the RDS-managed secret directly and never holds a copy of
      // a rotating password. See db/database-url.ts.
      ...pgOptions(
        resolveDatabaseUrl({
          DATABASE_URL: config.get('DATABASE_URL'),
          DATABASE_HOST: config.get('DATABASE_HOST'),
          DATABASE_PORT: config.get('DATABASE_PORT'),
          DATABASE_NAME: config.get('DATABASE_NAME'),
          DATABASE_USER: config.get('DATABASE_USER'),
          DATABASE_PASSWORD: config.get('DATABASE_PASSWORD'),
          DATABASE_SSLMODE: config.get('DATABASE_SSLMODE'),
        }),
      ),
      /**
       * `min` DOES NOT PRE-CREATE CONNECTIONS. It is kept because it governs idle
       * REAPING, which is a real and useful effect — but not the effect the option's
       * name suggests, and not the one this code used to imply.
       *
       * Verified against the pinned dependency rather than the type declarations:
       * `@types/pg` types the option, so the compiler accepts it and says nothing.
       * In pg-pool 3.14.0 (`node_modules/.pnpm/pg-pool@3.14.0_pg@8.22.0/.../index.js`)
       * `min` appears exactly twice — line 90 normalises it (`this.options.min =
       * this.options.min || 0`) and line 124 reads it inside `_isAboveMin()`
       * (`return this._clients.length > this.options.min`). Its only consumers are
       * lines 409-411, where an idle client is removed only `if
       * (this.options.idleTimeoutMillis && this._isAboveMin())`. There is no code path
       * anywhere in the pool that opens a connection because `min` is set: the pool
       * creates clients lazily, on `connect()`.
       *
       * So the floor it establishes is a floor on connections that ALREADY EXIST — it
       * stops `idleTimeoutMillis` (30s below) from reaping the pool back to zero
       * between requests, which on a low-traffic environment is most of the time.
       * That is worth having, and it is why the alternative — deleting the option as
       * dead config — was rejected. Together with `onModuleInit` below the two halves
       * finally mean what the single line used to claim: warm-up opens the floor,
       * `min` keeps it open.
       */
      min: config.get('DATABASE_POOL_MIN'),
      max: config.get('DATABASE_POOL_MAX'),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });

    this.db = drizzle(this.pool, { schema, logger: config.get('LOG_SQL') });
  }

  get instance(): DrizzleDB {
    return this.db;
  }

  /**
   * Open (and immediately release) `DATABASE_POOL_MIN` connections before the process
   * accepts traffic, so the first real request does not pay for establishing one.
   *
   * WHY THIS IS NEEDED AT ALL. `min` does not do it (see the comment on the option
   * above), so a freshly started task's pool holds zero clients. The task is
   * nonetheless admitted to live traffic immediately, because the ALB target group
   * health-checks `/v1/healthz` (`infra/modules/stack/main.tf:423`) and that route is a
   * pure liveness probe — it returns a literal `{ status: 'ok' }` without touching a
   * dependency (`../observability/health.controller.ts`). The first request to arrive
   * therefore pays TCP + TLS + SCRAM authentication to RDS inside its own latency.
   * On a low-traffic environment there is no warm neighbour to absorb that, so the
   * single cold request IS the p99 — and every deploy replaces the task, so the
   * measurement recurs on a schedule rather than randomly.
   *
   * WHY `onModuleInit` AND NOT A CALL FROM main.ts. Nest awaits this hook before the
   * listening socket exists, which is the ordering the whole fix depends on, so it was
   * worth confirming rather than assuming. `NestApplication.listen()` calls `await
   * this.init()` when not yet initialised (`@nestjs/core@11.1.28`
   * `nest-application.js:176-178`); `init()` awaits `callInitHook()` at line 105 and
   * only then reaches the `httpAdapter.listen(...)` promise further down the method.
   * `apps/api/src/main.ts:38` awaits `app.listen(port, host)`, so no request can be
   * served until this method has settled.
   *
   * The worker also constructs this provider, and warms up too. That is deliberate
   * rather than overlooked: `apps/worker/src/main.ts` uses
   * `NestFactory.createApplicationContext`, so it has no inbound HTTP and no cold-start
   * p99 to protect — but its relays issue their first query almost at once, and paying
   * the handshake during boot rather than inside the first job costs nothing and keeps
   * one code path instead of two.
   *
   * CONNECTIONS ARE ACQUIRED CONCURRENTLY, and must be. A sequential
   * connect-then-release loop hands back the same idle client on every iteration and
   * ends with a pool of ONE, having looked like it worked. Holding all `n` at once is
   * what forces the pool to create `n` distinct clients; releasing them then returns
   * them as idle, which is the state we want.
   *
   * FAILURE IS LOGGED, NOT THROWN, and the usual reason does not apply here. Rally
   * argues that a hard throw is safe because its pipeline gates on a readiness endpoint
   * that does check the database. OpsHub does have such an endpoint — `/v1/readyz`
   * runs `SELECT 1` — but NOTHING CONSUMES IT as a gate: the ALB health-checks
   * `/v1/healthz`, and `deploy` in `.github/workflows/backend-deploy.yml` delegates to
   * `QNSC-VN/qnsc-ci/.github/workflows/backend-deploy.yml@v1.13.1` with no smoke step
   * in this repo. So that argument is not available, and it should not be borrowed.
   *
   * The argument that does hold is narrower and does not depend on any gate: warm-up is
   * a pure optimisation over the previous behaviour. If it fails, the pool is exactly
   * as cold as it was before this method existed — which is the state production has
   * been running in — so throwing would trade a known-acceptable cold start for a boot
   * crash loop and buy nothing. A database that is genuinely unreachable will fail the
   * first request either way; the difference is that a task which is up and slow can
   * still serve, and a task stuck in a restart loop cannot.
   */
  async onModuleInit(): Promise<void> {
    // Clamped because the env schema validates the two bounds independently — both are
    // `positive()` ints, neither is checked against the other — so a misconfigured
    // MIN > MAX is representable. Unclamped, the surplus `connect()` calls would queue
    // behind an exhausted pool and resolve only by hitting `connectionTimeoutMillis`,
    // turning a typo into five seconds of silent boot delay.
    const target = Math.min(this.config.get('DATABASE_POOL_MIN'), this.config.get('DATABASE_POOL_MAX'));
    if (target <= 0) return;

    const startedAt = Date.now();
    try {
      const clients = await Promise.all(Array.from({ length: target }, () => this.pool.connect()));
      for (const client of clients) client.release();
      this.logger.log(`Database pool warmed: ${target} connection(s) in ${Date.now() - startedAt}ms`);
    } catch (err) {
      this.logger.warn(
        `Database pool warm-up failed after ${Date.now() - startedAt}ms; continuing with a cold pool. ` +
          `The first request will pay connection setup. Error: ${String(err)}`,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
