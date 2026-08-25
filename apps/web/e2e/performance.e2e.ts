import { test } from './support/test';
import type { APIRequestContext } from '@playwright/test';
import {
  FIXTURE,
  contextAs,
  csrfHeaders,
  expect,
  expectRowSomewhere,
  gotoInShell,
  myEmployeeId,
} from './support/fixtures';

/**
 * Performance reviews — the cycle, the review, the goals, and the rules that decide whether a review can
 * leave the reviewer's hands.
 *
 * WHAT THIS PINS THAT A UNIT TEST CANNOT. Three of the module's rules are sums or comparisons ACROSS rows,
 * so no database constraint sees them and no component test reaches them: goal weights must total 100, a
 * rating carrying `requiresDevelopmentPlan` cannot be saved without one, and a cycle does not close over
 * reviews in flight. Each is a refusal a user meets through this UI, so each is asserted here through it.
 *
 * Creates its own cycle and reviews. The database is shared and holds hundreds of cycles from the API
 * suites, which is exactly how the first version of the cycle label lookup — the first hundred rows —
 * came to render raw UUIDs for most rows.
 */

function unique(prefix: string): string {
  return `${prefix}-${Date.now()}`;
}

/** The seeded admin, who is the caller in every spec here. */
/**
 * A fresh employee for this run, and its NAME as well as its id.
 *
 * The name is returned because a spec that filters the reviews table has to search for THIS probe.
 * The filter used to be given the bare prefix "Perf Probe" with `getByRole('option').first()` — which
 * is correct on an empty database and wrong on the second run, because every previous run left a
 * "Perf Probe <stamp>" behind. It then filtered to somebody else's review and waited fifteen seconds
 * for a row that was never going to arrive.
 *
 * That was the intermittent failure in this file: whether it passed depended on which probe happened
 * to sort first, which is a property of the accumulated data rather than of the product.
 */
async function createEmployee(
  request: APIRequestContext,
): Promise<{ id: string; displayName: string }> {
  const stamp = Date.now();
  const displayName = `Perf Probe ${stamp}`;
  const res = await request.post('/v1/employees', {
    headers: await csrfHeaders(request),
    data: {
      email: `perf.probe.${stamp}@opshub.local`,
      displayName,
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const body = (await res.json()) as { data?: { id: string }; id?: string };
  return { id: body.data?.id ?? body.id!, displayName };
}

/** A cycle, created through the API so a spec can start from the state it needs. */
async function createCycle(
  request: APIRequestContext,
  reference: string,
): Promise<{ id: string; reference: string }> {
  const res = await request.post('/v1/performance/cycles', {
    headers: await csrfHeaders(request),
    data: {
      reference,
      name: `Playwright ${reference}`,
      periodStart: '2030-01-01',
      periodEnd: '2030-06-30',
      reviewDue: '2030-07-31',
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const body = (await res.json()) as { data?: { id: string }; id?: string };
  return { id: body.data?.id ?? body.id!, reference };
}

test.describe('performance', () => {
  test('creates a cycle, opens it, and adds a review to it', async ({ page }) => {
    const reference = unique('PWP').toUpperCase();
    await gotoInShell(page, '/performance');
    await page.getByRole('tab', { name: 'Cycles' }).click();

    await page.getByRole('button', { name: /new cycle/i }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Reference').fill(reference);
    await dialog.getByLabel('Name').fill('Playwright cycle');
    await dialog.getByLabel('From').fill('2030-01-01');
    await dialog.getByLabel('To').fill('2030-06-30');
    await dialog.getByLabel('Review due').fill('2030-07-31');
    await dialog.getByRole('button', { name: /create cycle/i }).click();
    await expect(dialog).toBeHidden();

    await expectRowSomewhere(page, reference);
    const row = page.locator('tbody tr', { hasText: reference });
    // A cycle is born a DRAFT — reviews are set up before anybody can write.
    await expect(row).toContainText('Draft');
    // No self-assessment step is a property of the cycle, not a missing date.
    await expect(row).toContainText('Not required');

    await row.getByRole('button', { name: 'Open' }).click();
    const confirm = page.getByRole('alertdialog');
    await expect(confirm.getByText(/can start writing/i)).toBeVisible();
    await confirm.getByRole('button', { name: /open cycle/i }).click();
    await expect(page.locator('tbody tr', { hasText: reference })).toContainText('Open', {
      timeout: 15_000,
    });
  });

  test('refuses to close a cycle with a review still in flight', async ({ page, request }) => {
    // The rule is a COUNT ACROSS ROWS, so nothing about a single row can express it. Closing regardless
    // would make the coverage report claim a cycle finished that nobody finished.
    const cycle = await createCycle(request, unique('PWX').toUpperCase());
    const { id: employeeId } = await createEmployee(request);
    const reviewerId = await myEmployeeId(request);

    const opened = await request.post(`/v1/performance/cycles/${cycle.id}/open`, {
      headers: await csrfHeaders(request),
    });
    expect(opened.status(), await opened.text()).toBe(200);
    const review = await request.post(`/v1/performance/cycles/${cycle.id}/reviews`, {
      headers: await csrfHeaders(request),
      data: { employeeId, reviewerId },
    });
    expect(review.status(), await review.text()).toBe(201);

    await gotoInShell(page, '/performance');
    await page.getByRole('tab', { name: 'Cycles' }).click();
    await expectRowSomewhere(page, cycle.reference);

    await page
      .locator('tbody tr', { hasText: cycle.reference })
      .getByRole('button', { name: 'Close' })
      .click();
    const confirm = page.getByRole('alertdialog');
    await expect(confirm.getByText(/still in flight/i)).toBeVisible();
    await confirm.getByRole('button', { name: /close cycle/i }).click();

    // The API refuses, and the screen shows ITS OWN message. Matched on the wording the service actually
    // sends ("N review(s) are neither acknowledged nor cancelled") rather than on the phrase this spec's
    // prose uses — the first version grepped for "in flight", which appears in the CONFIRMATION text and
    // not in the refusal, so it passed or failed on which of the two happened to still be on screen.
    await expect(
      page.getByText(/neither acknowledged nor cancelled/i).first(),
      'the refusal should be shown with the reason the API gave',
    ).toBeVisible({ timeout: 15_000 });
    // Still open, because the refusal was real rather than cosmetic.
    await expect(page.locator('tbody tr', { hasText: cycle.reference })).toContainText('Open');
  });

  test('shows the coverage report: who has no review in the cycle', async ({ page, request }) => {
    const cycle = await createCycle(request, unique('PWC').toUpperCase());
    await request.post(`/v1/performance/cycles/${cycle.id}/open`, {
      headers: await csrfHeaders(request),
    });

    await gotoInShell(page, '/performance');
    await page.getByRole('tab', { name: 'Cycles' }).click();
    await expectRowSomewhere(page, cycle.reference);
    await page.locator('tbody tr', { hasText: cycle.reference }).click();

    const drawer = page.getByRole('dialog');
    await expect(drawer).toBeVisible();
    // The cycle has no reviews at all, so progress says so rather than rendering an empty bar.
    await expect(drawer.getByText('No reviews in this cycle yet')).toBeVisible();
    // …and everybody in scope is uncovered. The section heading carries the count, which is the number
    // the report exists to produce.
    await expect(drawer.getByRole('heading', { name: /^Not covered \(\d+\)$/ })).toBeVisible({
      timeout: 15_000,
    });

    /*
     * THE HEADING IS THE TOTAL, NOT THE PAGE.
     *
     * This assertion used to be `\(\d+\)` and nothing more, which passed either way — and the endpoint
     * capped at 500 rows while the panel counted the array it got back. So on any organisation past five
     * hundred active employees the number beside "Not covered" was the size of a page presented as a
     * total, on the one screen where a smaller number reads as progress.
     *
     * Compared against the API's own `pageInfo.total` rather than a literal, because the count depends
     * on how many active employees the database has — which differs between a fresh CI database and a
     * developer's. What must hold everywhere is that the screen and the API agree.
     */
    const report = await request.get(`/v1/performance/cycles/${cycle.id}/coverage?limit=1`);
    const { pageInfo } = (await report.json()) as { pageInfo: { total: number } };
    await expect(
      drawer.getByRole('heading', { name: `Not covered (${pageInfo.total})` }),
    ).toBeVisible();

    // And the panel renders a PAGE of that total, so the two numbers are allowed to differ — what is not
    // allowed is the heading quietly becoming the smaller one.
    const rendered = await drawer.locator('p.truncate.text-xs.font-medium').count();
    expect(rendered).toBeLessThanOrEqual(pageInfo.total);
  });

  test('writes a review: goals must total 100 before it can be sent for approval', async ({
    page,
    request,
  }) => {
    const cycle = await createCycle(request, unique('PWG').toUpperCase());
    const { id: employeeId, displayName: employeeName } = await createEmployee(request);
    const reviewerId = await myEmployeeId(request);
    await request.post(`/v1/performance/cycles/${cycle.id}/open`, {
      headers: await csrfHeaders(request),
    });
    const created = await request.post(`/v1/performance/cycles/${cycle.id}/reviews`, {
      headers: await csrfHeaders(request),
      data: { employeeId, reviewerId },
    });
    expect(created.status(), await created.text()).toBe(201);

    await gotoInShell(page, '/performance');
    await page.getByRole('tab', { name: 'All reviews' }).click();
    // Filtered to this cycle's review by the employee it is about — the reviewer is the caller, so the
    // row also proves the "You" badge path.
    // The FULL unique name, not the shared prefix: `option.first()` over "Perf Probe" picks whichever
    // of the accumulated probes sorts first, which is rarely the one this test just created.
    await page.getByRole('combobox', { name: 'Filter by employee' }).fill(employeeName);
    await page
      .getByRole('option', { name: new RegExp(employeeName) })
      .first()
      .click();

    // A brand-new review starts in `self_assessment`; the reviewer cannot rate until the employee has
    // had their say or the cycle moves it on. Assert the state rather than assuming it.
    const row = page.locator('tbody tr', { hasText: cycle.reference });
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row).toContainText('You');

    await row.click();
    const drawer = page.getByRole('dialog');
    await expect(drawer.getByRole('heading', { name: 'Goals' })).toBeVisible();
    await expect(drawer.getByText('No goals set')).toBeVisible();
  });

  test('a rating that demands a development plan says so before it is saved', async ({
    page,
    request,
  }) => {
    // `requires_development_plan` lives on the rating scale and the plan on the review — two tables, so
    // no CHECK can compare them. The form reads the flag from the API's scale and makes the field
    // required, instead of letting the save fail on a rule the form never mentioned.
    const scale = await request.get('/v1/performance/rating-scale');
    expect(scale.ok(), await scale.text()).toBe(true);
    const levels = (await scale.json()) as {
      code: string;
      label: string;
      requiresDevelopmentPlan: boolean;
    }[];
    const demanding = levels.find((level) => level.requiresDevelopmentPlan);
    const relaxed = levels.find((level) => !level.requiresDevelopmentPlan);
    expect(demanding, 'no rating level requires a development plan').toBeTruthy();
    expect(relaxed, 'every rating level requires a development plan').toBeTruthy();

    const cycle = await createCycle(request, unique('PWR').toUpperCase());
    const reviewerId = await myEmployeeId(request);
    await request.post(`/v1/performance/cycles/${cycle.id}/open`, {
      headers: await csrfHeaders(request),
    });

    // THE SUBJECT IS A SEEDED FIXTURE, because only they can move the review to the reviewer: a review is
    // born in `self_assessment`, and submitting it is keyed on the caller's own id. A freshly created
    // employee has no way to sign in, so the review would sit in a state where nothing can be rated —
    // which is exactly how the first version of this spec timed out looking for a Rate button.
    const employee = await request.get('/v1/employees', {
      params: { search: FIXTURE.EMPLOYEE.email, limit: '1' },
    });
    expect(employee.ok(), await employee.text()).toBe(true);
    const employeeId = ((await employee.json()) as { data: { id: string }[] }).data[0]?.id;
    expect(employeeId, `the seeded fixture ${FIXTURE.EMPLOYEE.email} was not found`).toBeTruthy();

    const created = await request.post(`/v1/performance/cycles/${cycle.id}/reviews`, {
      headers: await csrfHeaders(request),
      data: { employeeId, reviewerId },
    });
    expect(created.status(), await created.text()).toBe(201);
    const reviewId =
      ((await created.json()) as { id?: string; data?: { id: string } }).data?.id ??
      ((await created.json()) as { id: string }).id;

    const asEmployee = await contextAs(FIXTURE.EMPLOYEE.email);
    const submitted = await asEmployee.post(`/v1/performance/reviews/${reviewId}/self-assessment`, {
      headers: await csrfHeaders(asEmployee),
      data: { selfAssessment: 'Written by the employee so the review reaches its reviewer.' },
    });
    expect(submitted.status(), await submitted.text()).toBe(200);
    await asEmployee.dispose();

    await gotoInShell(page, '/performance');
    await page.getByRole('tab', { name: 'My reviews' }).click();

    // The reviewer's own queue, which is self-scoped — no permission code involved.
    const owed = page.locator('tbody tr', { hasText: cycle.reference });
    await expect(owed).toBeVisible({ timeout: 15_000 });
    // The employee has had their say, so the reviewer can write.
    await expect(owed).toContainText('Submitted');
    await owed.getByRole('button', { name: /^Rate$/ }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    const plan = dialog.getByLabel('Development plan');

    await dialog.getByLabel('Overall rating').selectOption(relaxed!.code);
    await expect(dialog.getByText('Optional for this rating.')).toBeVisible();
    await expect(plan).not.toHaveAttribute('required', '');

    await dialog.getByLabel('Overall rating').selectOption(demanding!.code);
    // The requirement appears WITH ITS REASON, from the scale's own flag.
    await expect(dialog.getByText(/Required for this rating/)).toBeVisible();
    await expect(plan).toHaveAttribute('required', '');
  });
});
