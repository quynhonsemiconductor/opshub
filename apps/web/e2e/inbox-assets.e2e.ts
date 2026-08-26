import { test } from './support/test';
import type { APIRequestContext } from '@playwright/test';
import {
  clickFirstRow,
  createAccessRequest,
  csrfHeaders,
  expect,
  gotoInShell,
} from './support/fixtures';

/**
 * The inbox, the asset register and the service catalog — the three screens converted together.
 *
 * Each gets the assertion its conversion needs and no more: the inbox's footer count (its query used
 * to cast the response to `{ data, total }`, so the footer read "Showing 12 of undefined requests"),
 * the asset register's dialog and search, and the catalog's request flow — which used to enforce its
 * minimum reason length only by disabling the button.
 */
/**
 * A request in the unified inbox, raised BY the caller.
 *
 * TWO STEPS BECAUSE THERE IS NO `POST /v1/requests`. Domains submit into the engine, so the request is
 * raised through `/v1/access-requests` and then found in the inbox: `AccessRequestResponseDto` does not
 * expose the engine `requestId` it is backlinked to, and the inbox has no search box to look it up by.
 *
 * The inbox is ordered `createdAt DESC`, so the newest of the caller's own pending `access_request`
 * immediately after the POST is the one just raised. Matched on all three fields rather than taking
 * `data[0]`, which would silently pick up another spec's row.
 *
 * THE SHORT ID IS NOT A UNIQUE HANDLE, which is why the caller below reaches the row by POSITION instead.
 * Ids are UUIDv7, so the first eight hex characters ARE the millisecond timestamp — and the two specs above
 * raise access requests within the same few milliseconds, so `tbody tr` filtered by that prefix matched
 * three rows. It is returned only to prove the row opened is the one just raised.
 */
async function raiseRequest(request: APIRequestContext): Promise<{ id: string; shortId: string }> {
  await createAccessRequest(request);

  const me = await request.get('/v1/auth/me');
  expect(me.ok(), await me.text()).toBe(true);
  const { sub } = (await me.json()) as { sub: string };

  const res = await request.get('/v1/requests?limit=25');
  expect(res.ok(), await res.text()).toBe(true);
  const body = (await res.json()) as {
    data?: { id: string; type: string; status: string; requesterId: string }[];
  };
  const mine = (body.data ?? []).find(
    (item) =>
      item.requesterId === sub && item.type === 'access_request' && item.status === 'pending',
  );
  expect(mine, 'the access request never reached the unified inbox').toBeTruthy();
  // The row prints the first eight characters of the id, which is the only handle the list offers.
  return { id: mine!.id, shortId: mine!.id.slice(0, 8) };
}

test.describe('requests inbox', () => {
  test('filters through a radiogroup and reports a real count', async ({ page, request }) => {
    // A FRESH database has no requests at all — CI's did not, mine did, and the footer correctly
    // renders nothing for an empty list, so this asserted against data it had not created.
    await createAccessRequest(request);
    await gotoInShell(page, '/requests');

    const filter = page.getByRole('radiogroup', { name: /filter requests/i });
    await expect(filter).toBeVisible();
    // Opens on "My queue"; "All" is the wider set and is what the count below is asserted against.
    await filter.getByRole('radio', { name: 'All' }).click();
    await expect(filter.getByRole('radio', { name: 'All' })).toHaveAttribute(
      'aria-checked',
      'true',
    );

    // The footer prints a NUMBER, not `undefined`. That is the whole regression.
    await expect(page.getByText(/\d+ requests? results?|\d+–\d+ of \d+/)).toBeVisible();
    await expect(page.getByText(/of undefined/)).toHaveCount(0);
  });

  test('opens a request drawer with its approval history', async ({ page, request }) => {
    await createAccessRequest(request);
    await gotoInShell(page, '/requests');
    await page.getByRole('radiogroup').getByRole('radio', { name: 'All' }).click();

    await clickFirstRow(page);
    const drawer = page.getByRole('dialog');
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole('heading', { name: 'Details' })).toBeVisible();
    await expect(drawer.getByText('Requester')).toBeVisible();
  });

  test('discusses a request, then withdraws it', async ({ page, request }) => {
    const req = await raiseRequest(request);
    await gotoInShell(page, '/requests');
    // "All", not "My queue": that filter is what is awaiting the caller's DECISION, and this request is
    // one the caller raised.
    await page.getByRole('radiogroup').getByRole('radio', { name: 'All' }).click();

    /*
     * THE FIRST ROW IS THE ONE JUST RAISED. The list is `createdAt DESC` and `raiseRequest` was the last
     * write before this navigation, so position is the reliable handle here — the visible id is not, being
     * the UUIDv7 millisecond prefix that three rows in this file share.
     */
    await clickFirstRow(page);
    const drawer = page.getByRole('dialog');
    await expect(drawer).toContainText(req.shortId);
    /*
     * THE DISCUSSION IS NOT THE ACTIVITY TIMELINE beside it. The trail is what the system recorded; this is
     * the only place on a request where a person can ask a question before the decision is made.
     */
    await expect(drawer.getByRole('heading', { name: 'Discussion' })).toBeVisible();
    await expect(drawer.getByText('No comments yet')).toBeVisible();

    const note = `Cost centre 4400 — ${Date.now()}`;
    await drawer.getByLabel('Add a comment').fill(note);
    await drawer.getByRole('button', { name: 'Post comment' }).click();
    await expect(drawer.getByText(note)).toBeVisible({ timeout: 15_000 });
    // The box empties on success, so a second thought is not posted as a duplicate of the first.
    await expect(drawer.getByLabel('Add a comment')).toHaveValue('');

    // WITHDRAWING IS THE REQUESTER'S ACT, and this caller raised it. An approver would have Reject.
    await drawer.getByRole('button', { name: 'Withdraw' }).click();
    const confirm = page.getByRole('alertdialog');
    await expect(confirm.getByText(/cannot be reopened/i)).toBeVisible();
    await confirm.getByRole('button', { name: /withdraw request/i }).click();

    /*
     * THE ROW STAYS AND ITS STATUS MOVES — cancelling is a transition, not a delete. And the DRAWER moves
     * with it, because it reads the row back out of the list rather than holding the copy it opened with: a
     * snapshot would still say "Pending" here, with Withdraw still on offer.
     */
    const row = page.locator('tbody tr').first();
    await expect(row).toContainText('Cancelled', { timeout: 15_000 });
    await expect(drawer.getByRole('button', { name: 'Withdraw' })).toHaveCount(0);
    // Nothing left to decide either: the row's actions key off the same two open statuses.
    await expect(row.getByRole('button', { name: 'Approve' })).toHaveCount(0);
    await expect(row.getByRole('button', { name: 'Reject' })).toHaveCount(0);

    // THE DISCUSSION SURVIVES, and stays open. `addComment` checks that the caller is a party and checks
    // nothing about status, so "rejected because the budget code was wrong, here is the right one" is still
    // a comment somebody can leave.
    await expect(drawer.getByText(note)).toBeVisible();
    await expect(drawer.getByRole('button', { name: 'Post comment' })).toBeVisible();
  });
});

test.describe('assets', () => {
  test('adds an asset through a dialog and finds it by search', async ({ page }) => {
    const tag = `PW-${Date.now()}`;
    await gotoInShell(page, '/assets');

    await page.getByRole('button', { name: /add asset/i }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Asset tag').fill(tag);
    await dialog.getByLabel('Manufacturer').fill('Playwright');
    await dialog.getByLabel('Model').fill('Test Model');
    await dialog.getByRole('button', { name: 'Add asset' }).click();
    await expect(dialog).toBeHidden();

    await page.getByRole('searchbox').fill(tag);
    await expect(page.locator('tbody tr', { hasText: tag })).toBeVisible({ timeout: 15_000 });
  });
});

test.describe('service catalog', () => {
  test('states why a too-short reason is refused, rather than only disabling the button', async ({
    page,
    request,
  }) => {
    // CREATES ITS OWN ITEM. The dev catalogue is EMPTY — the seed does not populate it — so a spec that
    // clicked "the first item" found nothing. Second time this lesson has cost a run (the compliance
    // journey assumed a seeded software catalogue), which is why the rule is now in the kit README:
    // create what you assert on.
    const name = `Playwright Item ${Date.now()}`;
    const created = await request.post('/v1/catalog', {
      headers: await csrfHeaders(request),
      data: {
        name,
        category: 'hardware',
        approvalPermission: 'asset.write',
        description: 'Created by an e2e spec',
        slaHours: 24,
      },
    });
    expect(created.status(), await created.text()).toBe(201);

    await gotoInShell(page, '/catalog');

    /*
     * ANCHORED. The card, its Edit action and its Remove action all carry the item's name in their
     * accessible name now that the catalog can be managed from the page — so an unanchored pattern
     * matches three elements and Playwright's strict mode refuses, correctly. `^` picks the card,
     * whose accessible name starts with the item's.
     */
    const item = page.getByRole('button', { name: new RegExp(`^${name}`) });
    await expect(item).toBeVisible();
    await item.click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    await dialog.getByRole('button', { name: /submit request/i }).click();
    // A message, not a silently inert button.
    await expect(dialog.getByText(/at least 10 characters/i)).toBeVisible();

    await dialog.getByLabel(/why do you need this/i).fill('Needed for onboarding the new starter.');
    await dialog.getByRole('button', { name: /submit request/i }).click();
    await expect(dialog).toBeHidden();
  });
});
