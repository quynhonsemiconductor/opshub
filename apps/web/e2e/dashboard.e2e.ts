import { test } from './support/test';
import { expect, gotoInShell } from './support/fixtures';

/**
 * The home screen, for the persona the shared session actually is.
 *
 * The shell spec proves `/` mounts and shows a heading. It does not prove the tiles resolved their
 * counts, that the links go anywhere, or that the layout matches the role — and the layout is now
 * DATA (`personas.ts`), so a wrong lookup would render a plausible-looking screen for the wrong
 * persona.
 *
 * `global-setup.ts` signs in as admin, so the admin layout is the one asserted: four tiles and two
 * sections. Reading the title's role suffix first means a fixture change fails here with a clear
 * message rather than as a mysterious count mismatch.
 */
test.describe('dashboard', () => {
  test('renders the admin layout, with counts resolved rather than skeletons', async ({ page }) => {
    await gotoInShell(page, '/');

    await expect(page.getByRole('heading', { name: /Overview · Platform Admin/ })).toBeVisible();

    // Four tiles, each a link with a figure. `tabular-nums` markup aside, what matters is that the
    // count arrived: a tile still loading shows no digits at all.
    const tiles = page.locator('a').filter({ hasText: /Hardware assets|Awaiting my approval/ });
    await expect(tiles.first()).toBeVisible();
    await expect(page.getByText('Hardware assets')).toBeVisible();
    await expect(page.getByText('Pending access grants')).toBeVisible();
    await expect(page.getByText('Open compliance issues')).toBeVisible();
    await expect(page.getByText('Awaiting my approval')).toBeVisible();

    // The admin's two sections, from the persona definition. Matched EXACTLY: "Operations" is also a
    // substring of the sidebar's "IT Operations" group and of the page description, so a loose match
    // finds three elements and Playwright rightly refuses to pick one.
    await expect(page.getByText('Platform Governance', { exact: true })).toBeVisible();
    await expect(page.getByText('Operations', { exact: true })).toBeVisible();
  });

  test('a tile navigates to the screen it counts', async ({ page }) => {
    // The whole point of a stat tile: the number is a door. A tile that shows a count and goes
    // nowhere is a decoration, and the definition carries the destination, so this proves the
    // definition is wired rather than merely present.
    await gotoInShell(page, '/');
    await page.getByText('Hardware assets').click();
    await expect(page).toHaveURL(/\/assets$/);
  });

  test('a section link navigates too', async ({ page }) => {
    await gotoInShell(page, '/');
    await page.getByText('Groups, permissions and memberships').click();
    await expect(page).toHaveURL(/\/settings\/access-control$/);
    await expect(page.getByRole('tab', { name: 'Roles' })).toBeVisible();
  });
});
