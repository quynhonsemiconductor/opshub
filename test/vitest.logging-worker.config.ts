import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';
import swc from 'unplugin-swc';

// The worker's logging conformance, in its OWN project: the API e2e config sets API-only variables (and loads `.env`) that the worker's env
// schema refuses. `pool: 'forks'` because the fixture changes the working directory, which a worker thread cannot do.
// Needs the dev Postgres and Valkey, like the e2e suite. Run: `pnpm test:logging-worker`.
export default defineConfig({
  plugins: [swc.vite(), tsconfigPaths()],
  test: {
    globals: true,
    environment: 'node',
    include: ['test/logging/**/*.conformance.spec.ts', 'test/worker/**/*.worker.spec.ts'],
    passWithNoTests: false,
    pool: 'forks',
    setupFiles: ['./test/logging/worker-env.fixture.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
