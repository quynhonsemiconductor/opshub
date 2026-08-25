import { expect, request, type APIRequestContext, type Locator, type Page } from '@playwright/test';

/**
 * ONE SIGNED-IN STATE PER SEAT, AND A SEAT PER TEST.
 *
 * The DEFAULT rate-limit tier allows 200 requests a minute keyed on the USER id, and it is one bucket
 * across every route that tier covers — so a whole spec's traffic lands in one place.
 *
 * WHAT WAS WRONG WITH FOUR SEATS PER FILE. Spec files were spread across four seats round-robin, which
 * balances the load BETWEEN files and does nothing about the load inside one. With `workers: 1` exactly
 * one file runs at a time, so one file's burst is one identity's burst. Measured from the API log during
 * a full browser run: 268 requests in a single 60-second window on one seat. Adding seats to that scheme
 * would not have changed the number, because the seat was never shared in the first place.
 *
 * That is also why the 429s were so confusing to attribute. `RateLimitGuard` is a GUARD, so it
 * short-circuits before the logging interceptor — nothing reaches the request log — and the refusal lands
 * on whichever request happens to be next. It arrived once as a broken certificate upload, and once as a
 * shell with no `nav`, which is what a 429 on the session bootstrap looks like from the outside.
 *
 * SO A SEAT BELONGS TO A TEST. `support/test.ts` overrides the `storageState` fixture per test, spreading
 * a file's tests across all eight. The busiest file has seven tests and a test averages around forty
 * requests, so every test gets its own bucket with several times the headroom it needs.
 *
 * Still deliberately NOT solved by making the limiter configurable. A control tests can turn down stops
 * describing production — and this needed no such thing, because a test genuinely IS a separate session
 * and giving it a separate identity is the honest model rather than a workaround.
 */
export const AUTH_STATES = [
  'e2e/.auth/state.json',
  'e2e/.auth/state-2.json',
  'e2e/.auth/state-3.json',
  'e2e/.auth/state-4.json',
  'e2e/.auth/state-5.json',
  'e2e/.auth/state-6.json',
  'e2e/.auth/state-7.json',
  'e2e/.auth/state-8.json',
] as const;

/** The primary seat, for the global setup's own sanity check and anything not sharded. */
export const AUTH_STATE = AUTH_STATES[0];

/**
 * THE "STARTS ON THE LOGIN PAGE" FLAKE, RESOLVED.
 *
 * This file used to record it as an open question: roughly one full run in three, one spec on a
 * non-primary seat began on the login page and `gotoInShell` failed on the missing `nav`. Valkey
 * eviction and session revocation were both measured and ruled out. The rate limiter was ruled out too,
 * on the grounds that "a 429 does not clear a session".
 *
 * That reasoning was sound and it eliminated the wrong theory. A 429 on the bootstrap request does not
 * clear a session — it stops the app loading, so the router renders the login page and there is no `nav`
 * to find. The evidence is a run where one failure carried a literal
 * `{"code":"RATE_LIMITED"}` body and the others were this symptom, in the same minute.
 *
 * Per-test seats remove the cause. Left written down because the elimination was the interesting part:
 * the theory was right and the test of it was wrong.
 */

/**
 * Seeded principals, from `db/seed.ts` — one employee per system role.
 *
 * `ADMIN` holds the wildcard permission, so it is the tier that must see everything. `EMPLOYEE`
 * holds NO permission codes at all by design (self-service is expressed by scope, not by a
 * code), which makes it the tier every narrowing rule has to constrain.
 */
export const FIXTURE = {
  ADMIN: { email: 'admin@opshub.local' },
  EMPLOYEE: { email: 'employee@opshub.local' },
} as const;

/**
 * The admin seats, in the same order as `AUTH_STATES`. All eight hold the same role; only the identity —
 * and therefore the rate-limit bucket — differs. Seeded by `db/seed.ts`.
 */
export const SEAT_EMAILS = [
  'admin@opshub.local',
  'admin2@opshub.local',
  'admin3@opshub.local',
  'admin4@opshub.local',
  'admin5@opshub.local',
  'admin6@opshub.local',
  'admin7@opshub.local',
  'admin8@opshub.local',
] as const;

/**
 * Give React Query a beat to settle.
 *
 * DOES NOT wait for `networkidle`. The SPA holds a Server-Sent Events notification stream open
 * (`GET /v1/notifications/stream`), so the network never goes idle and any wait for it burns the
 * full timeout before failing. Prefer an element assertion — Playwright auto-waits those — and
 * use this only where a list has to re-fetch after a write.
 */
export async function settle(page: Page, ms = 1500): Promise<void> {
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(ms);
}

/**
 * Open a route and wait for the authenticated shell, not a fixed delay.
 *
 * Asserting the shell is present is what distinguishes "the page rendered" from "the session
 * expired and we bounced to /login" — the second is otherwise a passing test against an empty
 * screen. The sidebar navigation only exists inside the shell.
 */
export async function gotoInShell(page: Page, path: string): Promise<void> {
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('nav').first()).toBeVisible({ timeout: 20_000 });
  expect(
    new URL(page.url()).pathname,
    'bounced to the login page — the session did not load',
  ).not.toContain('login');
}

/**
 * The CSRF token the API requires on every mutation.
 *
 * The saved storage state carries the SESSION cookie only, so a bare `request.post` comes back
 * `FORBIDDEN: Missing csrf secret` — which reads like an authorization bug in the route rather than a
 * missing header in the test. `GET /v1/auth/me` is where the SPA itself gets the token.
 */
export async function csrfHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const me = await request.get('/v1/auth/me');
  expect(me.ok(), await me.text()).toBe(true);
  const { csrfToken } = (await me.json()) as { csrfToken?: string };
  expect(csrfToken, 'GET /auth/me did not return a CSRF token').toBeTruthy();
  return { 'X-CSRF-Token': csrfToken! };
}

/**
 * A request context signed in as somebody ELSE, isolated from the spec's own session.
 *
 * Some flows can only be advanced by a different person: a performance review reaches its reviewer only
 * when the SUBJECT submits a self-assessment, and the API keys that on the caller's own id.
 *
 * VIA THE BFF LOGIN, NOT `/v1/auth/dev-login`. The latter carries the `AUTH_LOGIN` tier — FIVE attempts
 * per fifteen minutes, keyed on the IP — which a suite cannot spend on bookkeeping: it failed exactly that
 * way, `RATE_LIMITED` on a helper the test was not testing. `/v1/bff/dev-login` sits on the default tier,
 * and brute-force protection on a passwordless dev route that 404s in production is protecting nothing.
 *
 * A FRESH CONTEXT, so the new session cookie cannot overwrite the one every other call in the spec uses.
 * Dispose it when done.
 */
export async function contextAs(email: string): Promise<APIRequestContext> {
  const context = await request.newContext({ baseURL: 'http://localhost:5173' });
  const res = await context.post('/v1/bff/dev-login', { data: { email } });
  expect(res.ok(), `bff dev-login failed for ${email}: ${res.status()} ${await res.text()}`).toBe(
    true,
  );
  return context;
}

/**
 * A tiny REAL PDF, so the MIME allow-list and the size check see what they expect.
 *
 * Shared because two upload journeys need one — a training certificate and a leave-request document — and a
 * second hand-rolled byte string is a second thing to get subtly wrong.
 */
export const PDF_BYTES = Buffer.from(
  '255044462d312e340a25c7ec8fa20a312030206f626a0a3c3c2f547970652f436174616c6f672f50616765732032203020523e3e0a656e646f626a0a747261696c65720a3c3c2f526f6f742031203020523e3e0a2525454f46',
  'hex',
);

/**
 * The signed-in seat's own employee id.
 *
 * Every spec that has to name an OWNER needs this, and three of them had grown their own copy — which is
 * how one of them would eventually keep calling a route the others had moved on from. `sub` on `/auth/me`
 * IS the employee id here; that is not obvious enough to re-derive per file.
 */
export async function myEmployeeId(request: APIRequestContext): Promise<string> {
  const me = await request.get('/v1/auth/me');
  expect(me.ok(), await me.text()).toBe(true);
  return ((await me.json()) as { sub: string }).sub;
}

/**
 * A register risk, owned by the caller, through the API.
 *
 * Shared because two suites need one for different reasons: the risk register's own journeys, and the
 * supplier screen, which links a risk to a vendor. The SCORE is passed in because the band a risk falls
 * into is what several assertions are about — `likelihood × impact` is a generated column, so the only way
 * to choose the band is to choose the factors.
 */
export async function createRisk(
  request: APIRequestContext,
  reference: string,
  likelihood: number,
  impact: number,
): Promise<{ id: string; reference: string }> {
  const ownerId = await myEmployeeId(request);
  const res = await request.post('/v1/risks', {
    headers: await csrfHeaders(request),
    data: {
      reference,
      title: `Playwright risk ${reference}`,
      description: 'Created by an e2e spec so the register has something to act on.',
      category: 'Access control',
      ownerId,
      inherent: { likelihood, impact },
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const body = (await res.json()) as { data?: { id: string }; id?: string };
  return { id: body.data?.id ?? body.id!, reference };
}

/**
 * Put one real item in the request engine, and return its id.
 *
 * Specs that assert on the inbox need a request to exist. A FRESH database has none — CI's does not,
 * mine did, and that difference is what failed this spec in CI while it passed locally for the third
 * time in this migration. Create what you assert on.
 */
export async function createAccessRequest(request: APIRequestContext): Promise<string> {
  const res = await request.post('/v1/access-requests', {
    headers: await csrfHeaders(request),
    data: {
      accessType: 'vpn',
      target: `playwright-${Date.now()}`,
      justification: 'Created by an e2e spec so the inbox has something to show.',
      durationHours: 8,
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const body = (await res.json()) as { data?: { id: string }; id?: string };
  return body.data?.id ?? body.id!;
}

/**
 * Find a row anywhere in the paged list, walking the pager.
 *
 * Lists page at 25 and order by a DOMAIN date rather than by creation — leave by `start_date DESC`,
 * contracts by their own order — so a row a spec just created is not necessarily on page 1 once a few
 * runs have accumulated. Asserting only the first page makes a spec pass or fail on how its random
 * fixture data happens to sort, which is a property of the data and not of the feature.
 *
 * Walking also proves the pager works, which is new on every screen this migration touched.
 *
 * LOOKS INSIDE A ROW, not anywhere on the page. The name says row and it used to accept a match in any
 * text node, which made it stop paging as soon as the reference appeared in something that was not the
 * table: the incidents screen prints the references of its five overdue breaches in a banner ABOVE the
 * list, so a spec whose fixture was overdue matched the banner on page 1, returned, and then failed on
 * the very next line because the actual row was on page 2. It read as a missing row on a screen that
 * was displaying the reference twice.
 *
 * SETTLES BEFORE IT LOOKS, on every page. Called straight after a filter change, the loop otherwise
 * reads the PREVIOUS result set: the row is missing because its page has not arrived yet, and the
 * pager still belongs to the old query — so the loop can page forward off the row it is looking for
 * and then report "not on any page" about a row sitting on page 1. Measured: the contracts journey
 * failed three runs out of three that way, with the row present in both the API and the DOM.
 */
export async function expectRowSomewhere(page: Page, text: string): Promise<void> {
  /*
   * REWIND FIRST. This walks FORWARD only, from wherever the list happens to be — and a spec that looked
   * for two rows in turn left the pager on the last page after the first lookup, so the second row (on
   * page one) was unreachable and the failure said "not on any page of the list" about a row that was.
   * Measured on the risk register, where the two rows sort to opposite ends by score.
   */
  for (let rewind = 0; rewind < 20; rewind++) {
    const previous = page.getByRole('button', { name: /Previous/ });
    if (!(await previous.isVisible().catch(() => false)) || (await previous.isDisabled())) break;
    await previous.click();
  }

  for (let attempt = 0; attempt < 10; attempt++) {
    await expect(page.getByText('Loading…')).toHaveCount(0, { timeout: 15_000 });
    if (
      await page
        .locator('tbody tr', { hasText: text })
        .first()
        .isVisible()
        .catch(() => false)
    )
      return;
    const next = page.getByRole('button', { name: /Next/ });
    if (!(await next.isVisible().catch(() => false)) || (await next.isDisabled())) break;
    await next.click();
  }
  // 15s, the same budget as every other "wait for a list to arrive" in this harness. 5s was enough
  // locally and not in CI, where a reload plus a tab click plus a fetch shared one budget — the leave
  // spec failed on it once and passed on retry, which is the signature of a timeout rather than a
  // missing row.
  await expect(
    page.locator('tbody tr', { hasText: text }).first(),
    `"${text}" was not in a row on any page of the list`,
  ).toBeVisible({ timeout: 15_000 });
}

/**
 * Move a list's status filter, and wait until it has actually moved.
 *
 * Every list screen filters by status through the same `SegmentedControl`, so the locator belongs here
 * once. The `aria-checked` wait is not decoration: it is the cheapest proof that React has committed
 * the state change, and therefore that the table is showing the new query's loading row rather than
 * the previous filter's rows. Without it a following assertion can read the OLD result set.
 */
export async function selectStatusFilter(page: Page, label: string): Promise<void> {
  const radio = page
    .getByRole('radiogroup', { name: /status/i })
    .getByRole('radio', { name: label });
  await radio.click();
  await expect(radio).toHaveAttribute('aria-checked', 'true');
}

/**
 * Choose a value from an `EntityPicker` by typing part of its name.
 *
 * SCOPED TO THE LISTBOX, and that is the whole reason this helper exists. A native `<select>` exposes
 * `role="option"` for each of its `<option>`s, so `page.getByRole('option').first()` on a form that has
 * both a picker and a select resolves to a hidden `<option>` and waits forever for it to become
 * clickable — measured on the risk form, where the first option belonged to the likelihood select.
 * `EntityPicker` renders a real `role="listbox"`, so scoping to it is unambiguous.
 *
 * `container` is the dialog or page the picker lives in; the listbox is queried from the PAGE because it
 * is positioned absolutely and may render outside the container's subtree.
 */
export async function chooseFromPicker(
  page: Page,
  container: Locator,
  label: string,
  term: string,
): Promise<void> {
  await container.getByLabel(label).fill(term);
  /*
   * The option MATCHING THE TERM, not the first one. The picker debounces its search by 250ms, so for a
   * moment the open list still holds the unfiltered page — and `.first()` then chose a different record
   * entirely. Measured: a requirement was added to whichever position sorted first, and the failure
   * surfaced two steps later as a dialog heading naming the wrong position.
   *
   * Waiting for the option whose name contains the term is the same wait AND the same assertion.
   */
  const option = page
    .getByRole('listbox')
    .getByRole('option', { name: new RegExp(escapeForRegExp(term), 'i') });
  await expect(option.first()).toBeVisible({ timeout: 15_000 });
  await option.first().click();
}

/** Terms come from test data and can contain regex metacharacters — `A.5.1`, `PW-1786…`. */
function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Click the first DATA row of a `DataTable`, once there is one.
 *
 * `tbody tr` also matches the table's own state rows — the loading placeholder, the error row, the empty
 * state — and those are single `colSpan` cells with no click handler. Clicking one does nothing, so a
 * spec that raced the fetch failed with "no dialog appeared", which reads like a broken drawer rather
 * than a test that clicked too early. Measured: it failed roughly one run in three.
 *
 * Waits for the loading row to go and for a row with more than one cell, which is what a data row is.
 */
export async function clickFirstRow(page: Page): Promise<void> {
  await expect(page.getByText('Loading…')).toHaveCount(0, { timeout: 15_000 });
  const dataRow = page
    .locator('tbody tr')
    .filter({ has: page.locator('td:nth-child(2)') })
    .first();
  await expect(dataRow).toBeVisible({ timeout: 15_000 });
  await dataRow.click();
}

export { expect };
