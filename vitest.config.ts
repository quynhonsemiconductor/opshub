import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';
import swc from 'unplugin-swc';

export default defineConfig({
  plugins: [
    // SWC must come first — emits decorator metadata that NestJS DI relies on
    swc.vite(),
    tsconfigPaths(),
  ],
  resolve: {
    // Prefer TypeScript source over compiled JS so stale build artefacts
    // living alongside .ts files don't shadow the real source.
    extensions: ['.ts', '.tsx', '.mts', '.mjs', '.js', '.jsx', '.json'],
  },
  test: {
    globals: true,
    environment: 'node',
    globalSetup: ['./test/global-setup.ts'],
    setupFiles: ['./test/setup.ts'],
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://test:test@localhost:5432/opshub_test',
      // identity 8 signs and encrypts with this; test-only value (the schema wants >= 32 characters).
      BETTER_AUTH_SECRET: 'test-better-auth-secret-minimum-32-chars!',
      CORS_ORIGINS: 'http://localhost:5173',
      LOG_LEVEL: 'fatal',
      LOG_PRETTY: 'false',
      LOG_SQL: 'false',
      OTEL_ENABLED: 'false',
      OTEL_SERVICE_NAME: 'opshub-api-test',
      COOKIE_SECRET: 'test-cookie-secret-minimum-32-chars!!',
      CSRF_SECRET: 'test-csrf-secret-minimum-32-characters!',
    },
    // `test/*.spec.ts` (one level, not recursive) picks up the cross-cutting
    // contract specs — the permission catalogue and the FE↔BE permission contract —
    // which belong to no single lib. Deliberately NOT `test/**` so anything added
    // under test/e2e stays with the separate e2e config that boots a real DB.
    // `db/**` is included because db/ holds production code the app imports, not just
    // migrations — db/database-url.ts composes the connection string every process
    // uses. A spec that never runs is worse than no spec, since it reads as coverage.
    // `apps/api` and `apps/worker`, not `apps/**`: the web app has its own vitest project
    // (apps/web/vitest.config.ts) that `Web · CI` runs, so sweeping it here would execute
    // the same specs twice — once per pipeline — and make coverage numbers depend on which
    // one you read.
    include: [
      'libs/**/*.spec.ts',
      'apps/api/**/*.spec.ts',
      'apps/worker/**/*.spec.ts',
      'db/**/*.spec.ts',
      'test/*.spec.ts',
    ],
    exclude: ['node_modules', 'dist'],
    coverage: {
      provider: 'v8',
      // `json-summary` writes coverage/coverage-summary.json, which
      // `pnpm check:coverage-floors` reads to enforce the ratchet described below.
      reporter: ['text', 'lcov', 'json-summary'],
      include: ['libs/**/*.ts', 'apps/api/**/*.ts', 'apps/worker/**/*.ts'],
      exclude: ['**/*.spec.ts', '**/*.module.ts', '**/index.ts'],
      // Coverage ratchet: floors sit just below current coverage so CI stays green while a
      // regression fails. Raise them as suites are added — never lower them.
      //
      // That instruction used to be a comment and nothing else, so it rotted: the note here
      // claimed ~16% while measured coverage had reached 22%, leaving 5-8 points of slack on
      // every metric — enough that a third of the suite could be deleted with CI still
      // green. `pnpm check:coverage-floors` now fails when any floor falls more than 3 points
      // behind actual, so raising these is no longer a thing to remember.
      //
      // Measured 2026-08-10: lines 31.82 / statements 31.58 / branches 26.13 / functions 22.03.
      // Raised from 28/19/24/28 as the ISMS modules landed (risk register, controls and the SoA,
      // incidents); before that from 25/17/21/26 when positions, contracts and the POST-status
      // ratchet landed;
      // before that, raised from 23/16/19/23 when the leave-entitlement work landed. In both cases
      // `check:coverage-floors` refused the change until they moved, which is the mechanism
      // working: a floor 3 points behind reality protects nothing.
      //
      // These went 21/14/17/21 → 24/24/19/16 when abstract-outbox-relay.spec.ts landed, then
      // DOWN to 23 when the unconsumed outbox leg was deleted (migration 0013). Lowering a
      // ratchet normally means a regression; this one is the benign case and the distinction
      // matters: no test was removed from surviving code. The deleted relay and
      // aws-client.config were better covered than the repo average, so removing them and
      // their specs together lowered the mean while leaving every remaining line as tested as
      // before. `pnpm check:coverage-floors` fails in BOTH directions — it refused the raise
      // until the floors moved up, then refused the delete until they moved down — which is
      // why the number can be trusted to track reality rather than intent.
      // Raised 2026-08-19 when the email path's specs landed — `resend.provider.spec.ts` and the
      // sender-refusal cases in `env.schema.spec.ts`. Measured lines 37.06 / statements 36.75 /
      // branches 28.37 / functions 24.89, and `check:coverage-floors` refused the change until these
      // moved: lines had drifted 3.06 behind, which is exactly the "protects nothing" case it guards.
      // Set about a point under actual, so run-to-run variance does not fail a branch that added no
      // code.
      // Raised 2026-08-21, twice in one day and merged into one note. First the outbound-URL guard —
      // `outbound-url.spec.ts`, the relay's delivery-time cases, the SSRF end-to-end block — then the
      // SES transport's `ses.provider.spec.ts`. `check:coverage-floors` failed BOTH branches before the
      // floors moved: branches had drifted 3.44 behind on the first, which is past the 3-point limit
      // that means a floor protects nothing at all.
      // Measured on the two TOGETHER — lines 38.80 / statements 38.66 / branches 30.61 / functions
      // 26.32. Neither branch's own figure applies once both are in, which is why the rebase
      // re-measured rather than keeping whichever number won the conflict.
      // Raised 2026-10-11 when the Graph worker module, the lease-and-fence relay and the role-split env
      // schema landed with their specs (lines/functions nudged again after the review round: measured
      // 43.03 / 29.34). First measurement: lines 42.48 / statements 42.35 / branches 34.38 /
      // functions 28.78; `check:coverage-floors` refused the old 37/37/29/25 (5 points behind). Set about
      // two and a half points under actual so run-to-run variance does not fail a branch that added no
      // code, and still inside the 3-point limit.
      // Raised 2026-10-12 on the tree with identity 8 AND the Graph worker together. Removing the v7 auth code
      // (the BFF, the refresh-token service, the JWT guard: large, thinly tested) and adding the identity 8 specs
      // (session guard, sign-in hook, access model, offboarding, env schema) moved the measurement to lines
      // 45.51 / statements 45.40 / branches 36.42 / functions 31.16, and `check:coverage-floors` refused the
      // floors above (functions 4.16 and branches 4.42 behind, past the 3-point limit). Set about two and a
      // half points under actual, as above. Neither branch's own figure applies once both are in.
      // Raised 2026-10-13: lines 44. The platform-http adoption added specs (the access-log interceptor's metrics,
      // the client-address keys, the Pages proxy's neighbours in the env schema) and deleted a local sanitiser; lines
      // measured 46.02 and the 3-point limit refused 43.
      // Raised again 2026-10-13 after the health controller (untested boilerplate) went to platform-runtime and the
      // shutdown / readiness / pool specs landed: lines 46.34 / statements 46.24 / branches 37.06 / functions 31.75.
      thresholds: {
        lines: 44,
        functions: 29,
        branches: 35,
        statements: 44,
      },
    },
  },
});
