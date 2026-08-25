import { test } from './support/test';
import { expect, gotoInShell } from './support/fixtures';

/**
 * FinOps — the screen whose hand-written response types had drifted from the API.
 *
 * WHY THIS SPEC IS WORTH ITS RUNTIME
 * ----------------------------------
 * The page declared its own `PagedResult` with `total` at the top level; the API returns it inside
 * `pageInfo`. So the "Licenses tracked" tile read 0 no matter how many licences existed, and the pager
 * — gated on `total > 0` — never rendered, making everything past the first page unreachable. Nothing
 * failed: not the types (they were hand-written), not a test (there was none), not the eye (0 is a
 * plausible number for an empty catalogue).
 *
 * This asserts the number against a licence it creates, which is the only way that class of bug shows
 * up from the outside.
 */

/** Unique per run: the database is shared and never reset between Playwright runs. */
function uniqueProduct(): string {
  return `Playwright Licence ${Date.now()}`;
}

test.describe('finops', () => {
  test('counts the licences it can see, and shows the one just added', async ({ page }) => {
    const name = uniqueProduct();
    await gotoInShell(page, '/finops');

    await page
      .getByRole('button', { name: /add license/i })
      .first()
      .click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Product name').fill(name);
    await dialog.getByLabel('Vendor').fill('Playwright Inc');
    await dialog.getByLabel('Seats').fill('10');
    await dialog.getByLabel('Cost per seat').fill('12.50');
    await dialog.getByRole('button', { name: 'Add license' }).click();
    await expect(dialog).toBeHidden();

    // The row, with the money formatted from cents — 10 seats × $12.50.
    const row = page.locator('tbody tr', { hasText: name });
    await expect(row).toBeVisible();
    await expect(row).toContainText('US$12.50');
    await expect(row).toContainText('US$125.00');

    // THE TILE THAT ALWAYS READ ZERO. Any positive number proves it is reading `pageInfo.total`.
    const tile = page
      .locator('div')
      .filter({ hasText: /^Licenses tracked/ })
      .first();
    await expect(tile).toBeVisible();
    await expect(tile).not.toHaveText(/Licenses tracked\s*0$/);
  });

  test('renders the spend chart and the utilisation list without erroring', async ({ page }) => {
    await gotoInShell(page, '/finops');
    // Renamed with the figure it charts: the old heading said "Monthly", which was also the word the
    // tile used for a different number.
    await expect(page.getByRole('heading', { name: 'Committed spend by product' })).toBeVisible();
    // The two spend figures reconcile, and the idle one is the reason the page exists.
    await expect(page.getByText('Committed monthly spend')).toBeVisible();
    await expect(page.getByText('Idle spend')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Seat utilization' })).toBeVisible();
    await expect(page.getByText('Failed to load licenses.')).toHaveCount(0);
  });
});
