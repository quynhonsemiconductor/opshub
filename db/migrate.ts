/**
 * DB migration runner — called by CI as a gated job BEFORE deploying a new app version.
 * Uses DATABASE_MIGRATION_URL (privileged role) when set; falls back to DATABASE_URL.
 * Never run by the app process itself.
 */
try {
  process.loadEnvFile('.env');
} catch {
  /* no .env file — CI mode */
}

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import path from 'path';
import { seed, seedRbacCatalog } from './seed';
import { pgOptions } from './pg-ssl';
import { resolveDatabaseUrl, resolveMigrationUrl } from './database-url';
import { log } from './script-log';

// Resolves DATABASE_MIGRATION_URL, else DATABASE_URL, else composes from the
// DATABASE_* parts (the deployed path — credentials come straight from the RDS-managed
// secret, never a hand-maintained copy). Throws with a precise message listing what is
// missing, so the manual presence check this replaced is no longer needed.
let url: string;
try {
  url = resolveMigrationUrl();
} catch (err) {
  log.error({ err }, (err as Error).message);
  process.exit(1);
}

const pool = new Pool({ ...pgOptions(url), max: 1 });
const db = drizzle(pool);

async function run() {
  try {
    log.info('Running migrations...');
    await migrate(db, { migrationsFolder: path.join(__dirname, 'migrations') });
    log.info('✅  Migrations applied');

    // Seed uses the app connection, not the migration URL (admin role), so a grant the
    // app role is missing fails here rather than succeeding as the owner and hiding it.
    // Falls back to the migration URL when no separate app credential is configured,
    // which is every environment until the least-privilege roles land.
    const seedUrl = (() => {
      try {
        return resolveDatabaseUrl();
      } catch {
        return url;
      }
    })();

    // The RBAC reference catalogue (permissions + roles + grants) is prod-safe
    // reference data the app depends on to authorize anything — ensure it in
    // EVERY environment, independent of SEED_ON_DEPLOY.
    await seedRbacCatalog(seedUrl);
    log.info('✅  RBAC catalogue ensured');

    /**
     * Demo fixtures: login-able employees, sample assets, requests.
     *
     * TWO gates, not one. `SEED_ON_DEPLOY` is the switch; `NODE_ENV` is the floor.
     *
     * The switch alone was a comment where a guard belongs — "Never set
     * SEED_ON_DEPLOY=true in production" is advice, and advice does not stop a copied
     * tfvars stanza. Develop is live and read as real, so a single misplaced `true`
     * would put eight fake employees (admin@opshub.local and friends) into a database
     * people are asked to trust, and every bug report would then start by asking which
     * rows were fixtures. Nothing in `infra/` sets this variable today, which is
     * exactly why now is the cheap time to add the floor.
     *
     * Deployed migrator tasks run with `NODE_ENV=production` and nothing else does —
     * CI's ephemeral Postgres and a developer's machine do not — so the floor cannot
     * block a legitimate local or CI seed. Ported from rally, whose develop database
     * really did carry a fixture project for a while.
     */
    if (process.env['SEED_ON_DEPLOY'] === 'true') {
      if (process.env['NODE_ENV'] === 'production') {
        log.warn(
          '⚠️  SEED_ON_DEPLOY=true but NODE_ENV=production — demo seed REFUSED. ' +
            'Deployed environments get the RBAC catalogue only; fixtures are for local ' +
            'development (pnpm db:seed) and CI.',
        );
      } else {
        log.info('SEED_ON_DEPLOY=true — seeding demo fixtures...');
        await seed(seedUrl);
      }
    }
  } catch (err) {
    log.error({ err }, 'Migration failed');
    process.exit(1);
  } finally {
    await pool.end();
  }
}

void run();
