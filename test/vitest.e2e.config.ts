import { createRequire } from 'node:module';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';
import swc from 'unplugin-swc';

// Load .env before this config — and the AppModule it boots — reads process.env. Node does
// not auto-load .env files, and nothing else in the e2e path did, so ConfigModule's Zod
// validation failed on any machine without these already exported in the shell.
try {
  process.loadEnvFile('.env');
} catch {
  /* no .env file — CI injects the vars directly */
}

// E2E config: runs the real AppModule against a real Postgres + Valkey.
// Specs live in test/e2e/**/*.e2e.spec.ts and boot through test/e2e/support/harness.ts.
//
// Prereqs: `docker compose -f docker-compose.dev.yml up -d` and `pnpm db:seed`.
export default defineConfig({
  plugins: [swc.vite(), tsconfigPaths()],
  test: {
    globals: true,
    environment: 'node',
    include: ['test/e2e/**/*.e2e.spec.ts'],
    /**
     * NOT `passWithNoTests`. It was true while the directory was empty, which made the
     * `E2E tests` CI job report success having run nothing — the job existed, went green on
     * every PR, and tested exactly zero behaviour. A gate that cannot fail is worse than a
     * missing one, because it gets mistaken for coverage.
     *
     * Now that specs exist, an empty run means the glob broke or the files were not checked
     * out, and vitest exits non-zero saying so.
     */
    passWithNoTests: false,
    setupFiles: ['./test/setup.ts'],
    /**
     * ONE truncate + re-seed for the whole run. The specs create timesheets, leave and
     * requests and tear down NOTHING, so without this a developer's database grows on every
     * pass — and the leftovers then make list assertions count-dependent, or collide with
     * the seed's own fixed ids under `onConflictDoNothing`, which reports nothing and leaves
     * the fixture silently absent. Adopted from rally, which hit both.
     */
    globalSetup: ['./test/e2e/support/global-setup.ts'],
    testTimeout: 30_000,
    // Booting the real AppModule (Nest DI, Drizzle pool, Valkey) plus the fixture logins
    // runs well past the 30s default on a cold start.
    hookTimeout: 60_000,
    /**
     * Run spec FILES one at a time. These specs share ONE Postgres and ONE Valkey, and
     * vitest runs files in parallel workers by default — so two files can mutate
     * overlapping rows, and both draw from the same per-IP `AUTH_LOGIN` bucket during their
     * `beforeAll` logins. Both are cross-file interference, not real product flake. Serial
     * execution removes the class; tests within a file still run in order. Slower, but a
     * shared stateful backend cannot be driven in parallel without per-spec isolation,
     * which this suite does not have.
     *
     * Adopted from rally, where both failure modes were diagnosed the hard way.
     */
    fileParallelism: false,
  },
  resolve: {
    alias: {
      /**
       * ONE `nestjs-zod` instance, the CJS one.
       *
       * `GlobalExceptionFilter` maps a validation failure to 422 with field-level details by
       * testing `exception instanceof ZodValidationException`. It ships from
       * `@quynhonsemiconductor/platform-http` as CJS and `require`s the CJS build of `nestjs-zod`; the app's
       * own source is transformed by vite and imports the ESM build. Two module instances, a
       * distinct class identity in each, so the `instanceof` is false — under vitest ONLY. Nest's
       * default handling answers 400 `BAD_REQUEST` with `details: []`.
       *
       * Production is compiled CJS throughout and answers 422 `VALIDATION_FAILED` with the
       * issues; verified against the running API. So the suite was asserting a status the product
       * never emits, and would have kept passing if that mapping were deleted outright — the
       * "different app" failure the harness docstring exists to prevent.
       *
       * Aliasing to the CJS entry puts the app on the same module object the externalised filter
       * requires. `require.resolve` rather than a literal path because pnpm's store directory
       * carries a content hash that changes on every dependency bump. Anchored at
       * `process.cwd()` — vitest runs from the repo root — because the backend tsconfig compiles
       * to CJS and rejects `import.meta.url` outright.
       *
       * Inlining `@quynhonsemiconductor/platform-http` instead does NOT work: vite leaves the `require` calls
       * inside a CJS dependency alone, so the filter still reaches the CJS copy. Measured.
       *
       * The durable fix belongs upstream — a cross-package `instanceof` is fragile for every
       * consumer, and `platform-http` should test for `getZodError` structurally. Until that
       * ships, this keeps the e2e contract honest.
       */
      'nestjs-zod': createRequire(join(process.cwd(), 'package.json')).resolve('nestjs-zod'),
    },
  },
});
