import { defineConfig, devices } from '@playwright/test';
import { AUTH_STATE } from './e2e/support/fixtures';

/**
 * Playwright config for the OpsHub SPA.
 *
 * Assumes the API is on :3001 (`docker compose -f docker-compose.dev.yml up -d`,
 * `pnpm db:migrate`, `pnpm start:dev`) and the seed data is loaded. Playwright starts the Vite
 * dev server itself, which proxies `/v1` to the API.
 *
 * Run:  pnpm --filter opshub-web test:e2e
 *
 * SERIAL, ONE WORKER. These specs create real rows through the real API, and several assert on
 * "the thing I just made appears in this list". Parallel workers would interleave writes into
 * each other's lists, and the failure would look like a UI bug.
 *
 * SHARED LOGINS, EIGHT OF THEM, unlike rova, which logs in per test. rova has to: its bearer flow
 * rotates the refresh token on every use and revokes the family on reuse, so a shared session trips
 * that protection. OpsHub's SPA holds no tokens at all — auth is an opaque opshub.session_token (`__Host-` in production)
 * cookie backed by Valkey, and nothing rotates it within its 12 h life — so `global-setup.ts` signs in once PER SEAT and
 * `support/test.ts` hands each TEST one of those seats.
 *
 * A SEAT PER TEST, NOT PER FILE. The DEFAULT rate-limit tier is keyed on the user id, so the previous
 * scheme — spec files spread across four seats round-robin — balanced the load between files and did
 * nothing about the load inside one. With one worker a file runs alone, so a file's burst is one
 * identity's burst: measured at 268 requests in a single 60-second window against a tier of 200. Seats
 * are chosen in `support/test.ts` now, which is why there is one project here rather than four.
 *
 * The logins go through identity's `/api/auth/test-login` (loaded only with `IDENTITY_TEST_LOGIN=enabled`
 * and NODE_ENV `development` or `test`), which is not behind the API's rate-limit tiers.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.ts',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: 'http://localhost:5174',
    // Written by global-setup: the session cookie, so every spec starts signed in.
    storageState: AUTH_STATE,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  /**
   * ONE PROJECT. The seat is chosen per TEST by `support/test.ts`, which overrides the `storageState`
   * fixture — and a fixture override beats a project-level `use`, so keeping four projects here would
   * have been four identical browsers with a setting that never took effect.
   *
   * What the projects used to do was shard spec FILES across four seats. That balanced files against each
   * other and left a single file's traffic on a single identity, which is where the limit was crossed.
   */
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], storageState: AUTH_STATE },
    },
  ],
  webServer: {
    command: 'pnpm dev --port 5174',
    url: 'http://localhost:5174',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
