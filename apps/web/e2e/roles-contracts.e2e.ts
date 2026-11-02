import { test } from './support/test';
import type { APIRequestContext } from '@playwright/test';
import {
  csrfHeaders,
  expect,
  expectRowSomewhere,
  gotoInShell,
  myEmployeeId,
  selectStatusFilter,
} from './support/fixtures';

/**
 * Roles and contracts — the first two screens for modules that had an API and no UI.
 *
 * Both create what they assert on: a fresh database has no roles and no contracts, and the whole
 * point of these screens is that a role could not previously be created without a hand-written
 * POST.
 *
 * The contracts test also pins the ONE property that is easy to get wrong here: `compensation` comes
 * back null both when no pay is recorded and when the caller may not see it, and the UI must not
 * distinguish them. Admin holds `contract.compensation.read`, so a figure it entered must come back
 * visible — the negative direction needs a second identity and belongs in the API suite, which has one.
 */

function unique(prefix: string): string {
  return `${prefix}-${Date.now()}`;
}

/**
 * Create a role through the API.
 *
 * Used by the drawer test so it does not depend on the test above it having run — specs in a file share
 * a database, not an order guarantee, and "the first row exists" is exactly the assumption that has
 * failed three times in this migration.
 */
async function createRole(request: APIRequestContext): Promise<string> {
  const code = unique('PWX').toUpperCase();
  const res = await request.post('/v1/roles', {
    headers: await csrfHeaders(request),
    data: { code, title: 'Playwright Seeded', department: 'Quality', headcount: 2 },
  });
  expect(res.status(), await res.text()).toBe(201);
  return code;
}

test.describe('roles', () => {
  test('creates a role, assigns nobody, and reports its vacancies', async ({ page }) => {
    const code = unique('PW').toUpperCase();
    await gotoInShell(page, '/roles');

    // `.first()`: the header action and the empty-state action are both "New role", which is
    // correct for a user and ambiguous for a locator.
    await page
      .getByRole('button', { name: /new role/i })
      .first()
      .click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Code').fill(code);
    await dialog.getByLabel('Title').fill('Playwright Engineer');
    await dialog.getByLabel('Department').fill('Quality');
    await dialog.getByLabel('Headcount').fill('3');
    await dialog.getByRole('button', { name: /create role/i }).click();
    await expect(dialog).toBeHidden();

    // FOUND BY SEARCH, because the register is ordered by CODE: with hundreds of roles from the API
    // suites, a new `PW-…` code is wherever the alphabet puts it, which is not page one. The search box
    // is server-side as of #165, so this also proves the term reaches the API.
    await page.getByRole('searchbox').fill(code);
    const row = page.locator('tbody tr', { hasText: code });
    await expect(row).toBeVisible({ timeout: 15_000 });
    // Nobody assigned yet: 0 of 3 filled, 3 vacancies — the numbers the API computes, not the client.
    await expect(row).toContainText('0 / 3');
    await expect(row).toContainText('3');
  });

  test('shows the assignment list in the drawer, empty and honest', async ({ page, request }) => {
    // Opens the role THIS test created, found by search, rather than whichever row sorts first.
    //
    // `clickFirstRow` was wrong here in a way that only showed up later: the first row eventually became
    // a role holding an assignment that had already been ENDED, which is neither "nobody assigned"
    // nor "current" — so the assertion failed against a drawer that was rendering correctly. A spec that
    // asserts on state it did not create is asserting on the database's history.
    const code = await createRole(request);
    await gotoInShell(page, '/roles');
    await page.getByRole('searchbox').fill(code);
    const row = page.locator('tbody tr', { hasText: code });
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.click();

    const drawer = page.getByRole('dialog');
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole('heading', { name: 'Assignments' })).toBeVisible();
    // A role with nobody on it says so rather than rendering an empty table with no explanation.
    await expect(drawer.getByText('Nobody assigned yet')).toBeVisible();
  });
});

test.describe('contracts', () => {
  test('drafts a contract, shows the pay it may see, then activates it', async ({
    page,
    request,
  }) => {
    // The contract needs an employee that exists; create one rather than depending on the seed.
    const stamp = Date.now();
    const employeeName = `Contract Probe ${stamp}`;
    const created = await request.post('/v1/employees', {
      headers: await csrfHeaders(request),
      data: { email: `contract.probe.${stamp}@opshub.local`, displayName: employeeName },
    });
    expect(created.status(), await created.text()).toBe(201);
    // The id is not typed into the form any more — the picker searches by name — but reading the body
    // ONCE still matters here: calling `.json()` twice inside a `??` chain is how this came out
    // undefined and the draft silently failed validation, leaving a row that never appeared.
    const body = (await created.json()) as { data?: { id: string }; id?: string };
    expect(body.data?.id ?? body.id, 'the employee was created without an id').toBeTruthy();

    const reference = unique('PWC').toUpperCase();
    await gotoInShell(page, '/contracts');

    await page.getByRole('button', { name: /draft contract/i }).click();
    const dialog = page.getByRole('dialog');
    // A PICKER, not a UUID box. The field used to be `Employee ID` with the placeholder "UUID", which
    // meant opening the people screen and copying an id out of a URL to draft a contract.
    await dialog.getByLabel('Employee').fill(employeeName);
    await page.getByRole('option', { name: new RegExp(employeeName) }).click();
    await dialog.getByLabel('Reference').fill(reference);
    await dialog.getByLabel('Start date').fill('2030-02-04');
    await dialog.getByLabel('Base salary').fill('5000.00');
    await dialog.getByRole('button', { name: /save draft/i }).click();
    await expect(dialog).toBeHidden();

    // Drafts are not in the default "active" filter — the list opens on what binds people.
    await selectStatusFilter(page, 'Draft');

    // Walked rather than assumed on page 1: drafts accumulate across runs and this list pages at 25.
    await expectRowSomewhere(page, reference);
    const row = page.locator('tbody tr', { hasText: reference });
    // Admin holds `contract.compensation.read`, so the figure is visible rather than "Not shown".
    await expect(row).toContainText('5000.00');
    await expect(row).not.toContainText('Not shown');

    // Activating needs a SIGNATURE DATE, and this is the assertion that found the defect: the button
    // used to open a confirm dialog that sent an empty body, and the API answered 412
    // `CONTRACT_NOT_SIGNED` every time — so the contract stayed a draft while the UI showed a toast
    // blaming a rule it had not broken. The date field is pre-filled with today; submitting it as-is is
    // the common path.
    await row.getByRole('button', { name: 'Activate' }).click();
    const activateDialog = page.getByRole('dialog');
    await expect(activateDialog.getByText(/binding contract/i)).toBeVisible();
    await expect(activateDialog.getByLabel('Signed on')).not.toHaveValue('');
    await activateDialog.getByRole('button', { name: 'Activate' }).click();
    await expect(activateDialog).toBeHidden();

    await selectStatusFilter(page, 'Active');
    await expectRowSomewhere(page, reference);
  });

  test('the renewal toggle narrows to contracts ending soon', async ({ page }) => {
    await gotoInShell(page, '/contracts');
    const toggle = page.getByRole('button', { name: /renewing in 90 days/i });
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    // Either rows or the empty message — never an error, and never a stuck loading row.
    await expect(page.getByText('Failed to load contracts.')).toHaveCount(0);
    await expect(page.getByText('Loading…')).toHaveCount(0);
  });
});

test.describe('my own employment record', () => {
  test('names the role on your own profile, without permission to look one up', async ({
    page,
    request,
  }) => {
    /*
     * `/v1/roles/me` IS SELF-SCOPED AND HAD NO CALLER, so an employee could not see their own role
     * history anywhere in the product — reading it through the roles register needs `role.read`.
     *
     * THE ASSERTION IS THAT IT READS AS A TITLE. The route used to answer with a bare `roleId`, and a
     * screen showing a UUID is the "nobody knows a UUID" problem the SPA's picker exists to remove. The API
     * now resolves the code and title in the same query, and this is where that shows.
     */
    const code = unique('PWME').toUpperCase();
    const role = await request.post('/v1/roles', {
      headers: await csrfHeaders(request),
      data: { code, title: 'Playwright Own Role', department: 'Quality', headcount: 3 },
    });
    expect(role.status(), await role.text()).toBe(201);
    const roleId = ((await role.json()) as { id: string }).id;

    /*
     * DATED WELL AHEAD. Assigning somebody who already holds a role is a TRANSFER, and a transfer
     * cannot start before the assignment it closes began — the seats accumulate far-future assignments
     * across runs, so an earlier date answers `ROLE_INVALID_WINDOW`.
     */
    const assigned = await request.post(`/v1/roles/${roleId}/assignments`, {
      headers: await csrfHeaders(request),
      data: { employeeId: await myEmployeeId(request), effectiveFrom: '2046-01-01' },
    });
    expect(assigned.status(), await assigned.text()).toBe(201);

    await gotoInShell(page, '/profile');

    const roles = page.getByText('Playwright Own Role').first();
    await expect(roles).toBeVisible({ timeout: 15_000 });
    // The code beside it, and NOT the id — which is what this screen would have had to print before.
    await expect(page.getByText(code, { exact: true })).toBeVisible();
    await expect(page.getByText(roleId)).toHaveCount(0);

    // The contract half of the same section, also self-scoped and also previously uncalled. The seeded
    // admin has one, so the section must show something rather than the empty-state line.
    await expect(page.getByRole('heading', { name: 'Your contracts' })).toBeVisible();
  });
});
