import { test as base } from '@playwright/test';
import { AUTH_STATES } from './fixtures';

/**
 * `test`, with a rate-limit seat of its own.
 *
 * WHY SPECS IMPORT `test` FROM HERE rather than from `@playwright/test`. The API's DEFAULT rate-limit
 * tier allows 1200 requests a minute keyed on the user id, in one bucket across every route it covers. The
 * suite used to assign one of four seats per spec FILE, which spread the load between files and did
 * nothing about the load inside one — and with `workers: 1` a file runs alone, so a file's burst is one
 * identity's burst. Measured on a full run: 268 requests in a single 60-second window on one seat.
 *
 * A test is genuinely a separate session, so giving it a separate identity is a more faithful model than
 * the file-level split was, not a workaround. Eight seats over a busiest-file count of seven tests means
 * every test has its own bucket.
 *
 * ASSIGNED BY TITLE, NOT BY ORDER. A counter would renumber every test when one is added, so an
 * unrelated change would move which seat a test runs on — and a failure that only appears on one seat
 * would move with it. Hashing the full title path is stable: the same test uses the same seat until it is
 * renamed, and `--grep` on a subset does not shift anything.
 */
function seatFor(titlePath: string[]): string {
  // FNV-1a, because it is four lines and needs only to spread — not to resist anything.
  let hash = 0x811c9dc5;
  for (const char of titlePath.join(' ')) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return AUTH_STATES[hash % AUTH_STATES.length];
}

export const test = base.extend({
  storageState: async ({}, use, testInfo) => {
    await use(seatFor(testInfo.titlePath));
  },
});

export { expect } from '@playwright/test';
