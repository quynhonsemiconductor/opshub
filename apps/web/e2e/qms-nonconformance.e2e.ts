import { test } from './support/test';
import type { APIRequestContext, Locator } from '@playwright/test';
import {
  chooseFromPicker,
  csrfHeaders,
  expect,
  expectRowSomewhere,
  gotoInShell,
} from './support/fixtures';

/**
 * Click one of the drawer's state-transition buttons, having first waited for it to be there.
 *
 * WHY THIS EXISTS. Three of the tests below walk a CAPA through consecutive transitions — accept the
 * plan, start work, mark implemented — and they used to do it with three back-to-back clicks. This was
 * the only spec in the suite shaped that way, and it is also the only one that failed intermittently in
 * a full run while passing every time on its own.
 *
 * The race: each click fires a mutation, the cache invalidates, and the drawer re-renders its action
 * buttons from the NEW state. Clicking straight into the next button races that re-render, and
 * Playwright's actionability check is satisfied by a node that is about to be replaced.
 *
 * Waiting for the button to be visible is the right barrier rather than a timeout, because it IS the
 * state change: `start work` only appears once the plan has been accepted. So this asserts the
 * transition took effect as a side effect of driving the next one.
 */
async function advance(scope: Locator, name: RegExp): Promise<void> {
  const button = scope.getByRole('button', { name });
  await expect(button).toBeVisible();
  await button.click();
}

/**
 * The non-conformance register and the CAPA loop — the QMS screens whose rules are about rows in ANOTHER
 * table, which is exactly what a DB constraint cannot hold and a screen therefore tends to get wrong.
 *
 * WHAT THIS PINS THAT NOTHING ELSE CAN
 * ------------------------------------
 * - a grade's consequences (`requiresCapa`, `containmentDueDays`) come from the API's severity table and are
 *   shown where the grade is chosen, so a policy edit lands in the form
 * - CONTAINMENT BEFORE CLOSURE: an open finding is never offered Close, because `open → closed` is refused
 * - THE CLOSURE GATE: a contained finding whose grade demands a CAPA is still not offered Close, and the
 *   drawer says why — this is the rule the whole module exists for
 * - verifying a CAPA effective OPENS that gate, and Close then appears without a reload
 * - a CAPA's own owner is not offered the effectiveness review, because the review exists so that somebody
 *   else agrees it worked
 * - `ineffective` is a LOOP, not an end: the only move left is back to analysis
 */

function unique(prefix: string): string {
  return `${prefix}-${Date.now()}`.toUpperCase();
}

async function myEmployeeId(request: APIRequestContext): Promise<string> {
  const me = await request.get('/v1/auth/me');
  expect(me.ok(), await me.text()).toBe(true);
  return ((await me.json()) as { sub: string }).sub;
}

/**
 * An active employee who is NOT the caller.
 *
 * Needed because a CAPA's owner cannot verify their own CAPA. A spec that owned everything it created could
 * never reach `verified`, and so could never reach the closure gate opening — the thing worth testing.
 */
async function someoneElse(request: APIRequestContext): Promise<string> {
  const mine = await myEmployeeId(request);
  const res = await request.get('/v1/employees?status=active&limit=50&offset=0');
  expect(res.ok(), await res.text()).toBe(true);
  const rows = ((await res.json()) as { data: { id: string }[] }).data;
  const other = rows.find((employee) => employee.id !== mine);
  expect(
    other,
    'the seed has only one active employee, so no CAPA could ever be verified',
  ).toBeTruthy();
  return other!.id;
}

async function raiseFinding(
  request: APIRequestContext,
  reference: string,
  severity: 'observation' | 'minor' | 'major' | 'critical',
): Promise<{ id: string; reference: string }> {
  const ownerId = await myEmployeeId(request);
  const res = await request.post('/v1/nonconformances/report', {
    headers: await csrfHeaders(request),
    data: {
      reference,
      title: `Playwright finding ${reference}`,
      description: 'Raised by an e2e spec.',
      requirement: 'ISO 9001:2015 §8.5.1',
      source: 'internal_audit',
      severity,
      processArea: `Playwright ${reference}`,
      ownerId,
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const body = (await res.json()) as { data?: { id: string }; id?: string };
  return { id: body.data?.id ?? body.id!, reference };
}

async function contain(request: APIRequestContext, id: string): Promise<void> {
  const res = await request.post(`/v1/nonconformances/${id}/contain`, {
    headers: await csrfHeaders(request),
    data: { containmentAction: 'Stopped the release train pending review.' },
  });
  expect(res.ok(), await res.text()).toBe(true);
}

async function openCapa(
  request: APIRequestContext,
  nonconformanceId: string,
  reference: string,
  ownerId: string,
  /**
   * The queue orders by due date, NULLS LAST — so a CAPA with no date is on the LAST page, which is
   * correct for a work queue and is why the queue spec passes a date it can sort to the front by.
   */
  dueOn?: string,
): Promise<string> {
  const res = await request.post(`/v1/capas/for/${nonconformanceId}`, {
    headers: await csrfHeaders(request),
    data: { reference, ownerId, dueOn },
  });
  expect(res.status(), await res.text()).toBe(201);
  const body = (await res.json()) as { data?: { id: string }; id?: string };
  return body.data?.id ?? body.id!;
}

/** Open the finding's drawer from the register, searching for it first so paging cannot hide it. */
async function openDrawer(page: import('@playwright/test').Page, reference: string) {
  await page.getByRole('searchbox').fill(reference);
  const row = page.locator('tbody tr', { hasText: reference });
  await expect(row).toBeVisible({ timeout: 15_000 });
  // The reference appears in the row three times (reference, title, process area), so the row is opened by
  // its first cell rather than by text.
  await row.locator('td').first().click();
  // BY NAME, not by text: a modal opened from the drawer renders inside it, so `hasText` matches both.
  // Every dialog here is labelled by its heading, and the drawer's is the finding's title.
  const drawer = page.getByRole('dialog', { name: new RegExp(reference) });
  await expect(drawer).toBeVisible();
  return { row, drawer };
}

test.describe('non-conformances', () => {
  test('raises a finding, showing what the grade commits somebody to', async ({ page }) => {
    const reference = unique('PWNC');
    await gotoInShell(page, '/nonconformances');

    await page.getByRole('button', { name: /raise a finding/i }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    await dialog.getByLabel(/^Reference/).fill(reference);
    await dialog.getByLabel(/^Title/).fill('Release deployed without a recorded approval');
    await dialog.getByLabel(/^Requirement/).fill('ISO 9001:2015 §8.5.6');
    await dialog
      .getByLabel(/^Description/)
      .fill('Two of eleven releases had no approval recorded.');
    await dialog.getByLabel(/^Process area/).fill(`Playwright ${reference}`);

    // OBSERVATION FIRST, so the assertion below is about the grade and not about a constant string. The
    // API's own severity table says this one needs no CAPA.
    await dialog.getByLabel(/^Severity/).selectOption('observation');
    await expect(dialog.getByText(/can be closed on containment alone/i)).toBeVisible();

    // MAJOR SECOND. Same form, different obligation — read from `/nonconformances/severities`, so a policy
    // change to the grade lands here with no code change.
    await dialog.getByLabel(/^Severity/).selectOption('major');
    await expect(dialog.getByText(/cannot be closed until a CAPA/i)).toBeVisible();
    await expect(dialog.getByText(/Containment is due within \d+ day/i)).toBeVisible();

    await chooseFromPicker(page, dialog, 'Owner', 'Admin');

    await dialog.getByRole('button', { name: /raise finding/i }).click();
    await expect(dialog).toBeHidden();

    await expectRowSomewhere(page, reference);
    const row = page.locator('tbody tr', { hasText: reference });
    await expect(row).toContainText('Major');
    // The grade's consequence travels onto the row, so the register reads as obligations and not adjectives.
    await expect(row).toContainText('CAPA required');
    await expect(row).toContainText('Open');
    // Nothing verified of nothing opened — a number rather than a blank.
    await expect(row).toContainText('0/0');
  });

  test('an open finding is never offered Close, and a contained one waits for a verified CAPA', async ({
    page,
    request,
  }) => {
    const finding = await raiseFinding(request, unique('PWGATE'), 'major');
    await gotoInShell(page, '/nonconformances');

    // OPEN: containment is the only forward move. `open → closed` is refused by the service and by
    // `ck_nc_contained_states`, so offering Close here would be offering a refusal.
    //
    // Worked from the ROW and not from the drawer: the drawer is a modal, so its overlay makes the row's own
    // buttons unclickable — which is correct behaviour and was worth learning here rather than in a flake.
    await page.getByRole('searchbox').fill(finding.reference);
    let row = page.locator('tbody tr', { hasText: finding.reference });
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row.getByRole('button', { name: 'Contain' })).toBeVisible();
    await expect(row.getByRole('button', { name: 'Close' })).toHaveCount(0);

    await row.getByRole('button', { name: 'Contain' }).click();
    const dialog = page.getByRole('dialog', { name: /^Contain / });
    await dialog
      .getByLabel(/^Containment action/)
      .fill('Held the release train and re-ran the approval check.');
    // The closure requirement is restated at containment, because that is when it becomes actionable.
    await expect(dialog.getByText(/needs a CAPA verified effective/i)).toBeVisible();
    await dialog.getByRole('button', { name: /record containment/i }).click();
    await expect(dialog).toBeHidden();

    row = page.locator('tbody tr', { hasText: finding.reference });
    await expect(row).toContainText('Contained', { timeout: 15_000 });

    // CONTAINED, AND STILL NOT CLOSABLE. This is the gate: a cross-table rule no CHECK can hold, and the
    // register withholds the action rather than letting the API refuse it.
    await expect(row.getByRole('button', { name: 'Close' })).toHaveCount(0);

    const { drawer } = await openDrawer(page, finding.reference);
    await expect(drawer.getByText(/Contained, but not closable/i)).toBeVisible();
    await expect(drawer.getByText(/cannot close until one is verified effective/i)).toBeVisible();
  });

  test('a CAPA verified effective opens the gate, and the finding then closes', async ({
    page,
    request,
  }) => {
    const finding = await raiseFinding(request, unique('PWLOOP'), 'major');
    await contain(request, finding.id);
    // Owned by somebody else, so this seat may sign off the effectiveness review.
    await openCapa(request, finding.id, unique('PWCAPA'), await someoneElse(request));

    await gotoInShell(page, '/nonconformances');
    const { drawer } = await openDrawer(page, finding.reference);

    // ANALYSIS FIRST. `Accept plan` is withheld until a cause and a plan are on the row, because the service
    // refuses a plan built on no stated cause.
    await expect(drawer.getByRole('button', { name: /accept plan/i })).toHaveCount(0);
    await drawer.getByRole('button', { name: /record analysis/i }).click();

    let dialog = page.getByRole('dialog', { name: /^Analysis for/ });
    await dialog.getByLabel(/^Root cause/).fill('The approval gate was advisory, not enforced.');
    await dialog.getByLabel(/^Method/).selectOption('five_whys');
    await dialog.getByLabel(/^Action plan/).fill('Make the gate blocking in the pipeline.');
    await dialog.getByRole('button', { name: /save analysis/i }).click();
    await expect(dialog).toBeHidden();

    await advance(drawer, /accept plan/i);
    await advance(drawer, /start work/i);
    await advance(drawer, /mark implemented/i);

    dialog = page.getByRole('dialog', { name: /^Mark .+ implemented/ });
    await dialog.getByRole('button', { name: /mark implemented/i }).click();
    await expect(dialog).toBeHidden();

    // IMPLEMENTED IS NOT EFFECTIVE. The gate is still shut, because the claim that it worked has not been
    // made by anybody yet.
    await expect(drawer.getByText(/Contained, but not closable/i)).toBeVisible();

    await drawer.getByRole('button', { name: /verify effective/i }).click();
    dialog = page.getByRole('dialog', { name: /^Verify/ });
    await dialog
      .getByLabel(/^Effectiveness evidence/)
      .fill('Zero unapproved releases across 40 deploys since the gate became blocking.');
    await dialog.getByRole('button', { name: /verify effective/i }).click();
    await expect(dialog).toBeHidden();

    // THE GATE OPENS, on the API's count and with no reload: the warning goes and Close appears.
    await expect(drawer.getByText(/Effective/)).toBeVisible({ timeout: 15_000 });
    await expect(drawer.getByText(/Contained, but not closable/i)).toHaveCount(0);

    await expect(page.locator('tbody tr', { hasText: finding.reference })).toContainText('1/1', {
      timeout: 15_000,
    });
    // Closed from the DRAWER's own header action, which appeared the moment the gate opened — and has to be
    // used from here anyway, because the drawer is modal and its overlay covers the row's buttons.
    await drawer.getByRole('button', { name: 'Close', exact: true }).click();

    dialog = page.getByRole('dialog', { name: /^Close / });
    await dialog.getByLabel(/^Closure note/).fill('Gate is blocking; verified over 40 deploys.');
    await dialog.getByRole('button', { name: /close finding/i }).click();
    await expect(dialog).toBeHidden();

    await expect(page.locator('tbody tr', { hasText: finding.reference })).toContainText('Closed', {
      timeout: 15_000,
    });
  });

  test('the CAPA owner is not offered its own effectiveness review', async ({ page, request }) => {
    const finding = await raiseFinding(request, unique('PWSELF'), 'major');
    await contain(request, finding.id);
    // Owned by THIS seat, which is the case the API refuses with `CAPA_SELF_VERIFICATION`.
    await openCapa(request, finding.id, unique('PWCAPA'), await myEmployeeId(request));

    await gotoInShell(page, '/nonconformances');
    const { drawer } = await openDrawer(page, finding.reference);

    await drawer.getByRole('button', { name: /record analysis/i }).click();
    const dialog = page.getByRole('dialog', { name: /^Analysis for/ });
    await dialog.getByLabel(/^Root cause/).fill('Owned by the same person who would sign it off.');
    await dialog.getByLabel(/^Action plan/).fill('Reassign before verification.');
    await dialog.getByRole('button', { name: /save analysis/i }).click();
    await expect(dialog).toBeHidden();

    await advance(drawer, /accept plan/i);
    await advance(drawer, /start work/i);
    await advance(drawer, /mark implemented/i);
    const implemented = page.getByRole('dialog', { name: /^Mark .+ implemented/ });
    await implemented.getByRole('button', { name: /mark implemented/i }).click();
    await expect(implemented).toBeHidden();

    // No button, and the reason in its place — an action whose only outcome is a refusal is not offered.
    await expect(drawer.getByRole('button', { name: /verify effective/i })).toHaveCount(0);
    await expect(drawer.getByText(/somebody else signs off/i)).toBeVisible();
  });
});

test.describe('corrective actions', () => {
  test('ineffective is a loop back to analysis, not an ending', async ({ page, request }) => {
    const finding = await raiseFinding(request, unique('PWINEFF'), 'major');
    await contain(request, finding.id);
    const capaReference = unique('PWCAPA');
    await openCapa(request, finding.id, capaReference, await someoneElse(request));

    await gotoInShell(page, '/nonconformances');
    const { drawer } = await openDrawer(page, finding.reference);

    await drawer.getByRole('button', { name: /record analysis/i }).click();
    let dialog = page.getByRole('dialog', { name: /^Analysis for/ });
    await dialog.getByLabel(/^Root cause/).fill('Assumed the training gap was the cause.');
    await dialog.getByLabel(/^Action plan/).fill('Re-run the training.');
    await dialog.getByRole('button', { name: /save analysis/i }).click();
    await expect(dialog).toBeHidden();

    await advance(drawer, /accept plan/i);
    await advance(drawer, /start work/i);
    await advance(drawer, /mark implemented/i);
    dialog = page.getByRole('dialog', { name: /^Mark .+ implemented/ });
    await dialog.getByRole('button', { name: /mark implemented/i }).click();
    await expect(dialog).toBeHidden();

    await drawer.getByRole('button', { name: /not effective/i }).click();
    dialog = page.getByRole('dialog', { name: /ineffective/i });
    await dialog.getByLabel(/^Reason/).fill('It happened twice more after the training.');
    await dialog.getByRole('button', { name: /mark ineffective/i }).click();
    await expect(dialog).toBeHidden();

    // The CAPA is not finished, and the only forward move is back to analysis. Verification is gone: an
    // ineffective CAPA cannot be signed off without a new attempt.
    await expect(drawer.getByText('Ineffective').first()).toBeVisible({ timeout: 15_000 });
    await expect(drawer.getByRole('button', { name: /reopen analysis/i })).toBeVisible();
    await expect(drawer.getByRole('button', { name: /verify effective/i })).toHaveCount(0);
    // And the finding still cannot close, which is the whole point of the loop existing.
    await expect(drawer.getByText(/Contained, but not closable/i)).toBeVisible();

    await drawer.getByRole('button', { name: /reopen analysis/i }).click();
    // Back in analysis WITH a cause already on the row: the badge says this one has been round the loop,
    // which is the visible difference between a first attempt and a second.
    await expect(drawer.getByText('Re-analysis')).toBeVisible({ timeout: 15_000 });
    await expect(drawer.getByRole('button', { name: /revise analysis/i })).toBeVisible();
  });

  test('the CAPA queue names each finding and opens on the work', async ({ page, request }) => {
    const finding = await raiseFinding(request, unique('PWQUEUE'), 'major');
    await contain(request, finding.id);
    const capaReference = unique('PWCAPA');
    // Long overdue, so it sorts to the front of a queue ordered by due date.
    await openCapa(request, finding.id, capaReference, await someoneElse(request), '2020-01-01');

    await gotoInShell(page, '/capas');

    const card = page.getByRole('article', { name: capaReference });
    await expect(card).toBeVisible({ timeout: 15_000 });
    // The queue is read ACROSS findings, so a row that showed a UUID would be unreadable. The reference and
    // title come from a per-id query rather than a hopeful `limit=100` list.
    await expect(card).toContainText(finding.reference);
    await expect(card).toContainText('Analysis');
    // Same actions as the drawer, because it is the same component and the same transition map.
    await expect(card.getByRole('button', { name: /record analysis/i })).toBeVisible();
  });
});
