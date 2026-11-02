import { test } from './support/test';
import { expect, gotoInShell } from './support/fixtures';

/**
 * Access control, in depth — the third screen decomposed onto the kit, and the one whose route the
 * shell spec never visited.
 *
 * The groups list used to be clickable `<div>`s: no table semantics, no header, no empty state. It is a
 * real table now, which is what lets this spec assert on `row` and `columnheader` rather than on
 * class names.
 *
 * FULL LIFECYCLE, ON A GROUP IT CREATES. Creating a group is additive and safe in a shared database;
 * this then adds a permission to it and deletes it again, which is the only honest way to exercise the
 * confirm dialog and leaves nothing behind.
 */
test.describe('access control', () => {
  test('lists groups in a real table and moves between tabs by keyboard', async ({ page }) => {
    await gotoInShell(page, '/settings/access-control');

    const table = page.getByRole('table');
    await expect(table).toBeVisible();
    // Group · Type · Permissions · (actions)
    await expect(table.getByRole('columnheader')).toHaveCount(4);
    // The seed's system groups are always there, so an empty table is a failure.
    await expect(page.getByText('Platform Administrator')).toBeVisible();
    await expect(page.getByText('System').first()).toBeVisible();

    // A real tablist, so the arrow keys move it.
    await page.getByRole('tab', { name: 'Groups' }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('tab', { name: 'Memberships' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    // Memberships fetches nothing until an employee is named, and says so rather than showing an empty
    // table that would read as "this employee is in no group".
    await expect(page.getByText(/enter an employee id/i)).toBeVisible();

    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('tab', { name: 'Delegations' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.getByRole('table')).toBeVisible();
  });

  test('creates a group, grants it a permission, then deletes it', async ({ page }) => {
    const key = `playwright-${Date.now()}`;
    const name = `Playwright ${Date.now()}`;

    await gotoInShell(page, '/settings/access-control');
    await page.getByRole('button', { name: /new group/i }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    // Empty submit is refused, in the dialog rather than by the browser.
    await dialog.getByRole('button', { name: 'Create' }).click();
    await expect(dialog.getByText(/required/i)).toBeVisible();

    await dialog.getByLabel('Key').fill(key);
    await dialog.getByLabel('Display name').fill(name);
    await dialog.getByRole('button', { name: 'Create' }).click();
    await expect(dialog).toBeHidden();

    // Located by TEXT rather than by the row's accessible name: the name is computed from the cells,
    // and the two-line "name over key" cell does not put the key in it — so a name match finds
    // nothing while the row is plainly on screen. Measured, not guessed.
    const row = page.locator('tbody tr', { hasText: key });
    await expect(row).toBeVisible();
    // A CUSTOM group, so it is deletable — the system ones deliberately have no delete control.
    await expect(row.getByText('Custom')).toBeVisible();

    // The drawer grants a permission. Re-read from the list rather than a captured row, so the chip
    // appearing proves the mutation reached the API and the panel re-rendered from fresh data.
    await row.click();
    const drawer = page.getByRole('dialog');
    await expect(drawer).toBeVisible();
    await expect(drawer.getByText('No permissions assigned')).toBeVisible();

    await drawer.getByLabel('Permission to add').selectOption('audit.read');
    await drawer.getByRole('button', { name: 'Add', exact: true }).click();
    // Asserted on the CHIP's remove control, not on the text: `audit.read` is also an `<option>` in
    // the add select until the refetch drops it, so a text match finds two elements and races the
    // invalidation. The remove button exists only on a granted permission.
    await expect(drawer.getByRole('button', { name: 'Remove audit.read' })).toBeVisible({
      timeout: 10_000,
    });

    // Closed by its own control, not by Escape: `SlideOver` handles Escape on the PANEL, so it only
    // fires while focus is inside — and after the Add click focus can land on a button that just
    // re-rendered. The click below then times out against the still-open drawer's backdrop, which is
    // exactly how this was found.
    await drawer.getByRole('button', { name: 'Close panel' }).click();
    await expect(drawer).toBeHidden();

    // Deleting asks first. `role="alertdialog"`, not `dialog` — which is right for a destructive
    // confirmation and is why this locator is not `getByRole('dialog')`: an alert dialog interrupts,
    // and assistive tech treats the two differently.
    await page.getByRole('button', { name: `Delete ${name}` }).click();
    const confirm = page.getByRole('alertdialog');
    await expect(confirm.getByText(/cannot be undone/i)).toBeVisible();
    await confirm.getByRole('button', { name: /delete role/i }).click();

    await expect(page.locator('tbody tr', { hasText: key })).toHaveCount(0, { timeout: 10_000 });
  });
});
