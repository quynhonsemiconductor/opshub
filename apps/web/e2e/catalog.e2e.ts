import { test } from './support/test';
import { expect, gotoInShell } from './support/fixtures';

/**
 * The Service Catalog, end to end: publish an item, then request it.
 *
 * WHAT THIS PINS THAT NOTHING DID. `POST /v1/catalog`, `PATCH /v1/catalog/:id` and
 * `DELETE /v1/catalog/:id` have existed behind `catalog.manage` since the module was written, and the
 * SPA called none of them. The seed creates no items either. So the catalog — a top-level nav section,
 * and one of the two journeys an internal ops platform is bought for — was permanently empty for every
 * new tenant, with an empty state that offered no way out of itself. The only thing in the repo that
 * ever created an item was another Playwright spec posting raw HTTP.
 *
 * So the assertion that matters is the FIRST one: a signed-in manager can put something in the
 * catalog through the product. Everything after it was already reachable and is here to prove the
 * published item is genuinely usable rather than merely present.
 *
 * A UNIQUE NAME PER RUN. The database is shared and never reset, and the grid groups by category, so
 * a fixed name would match a previous run's card.
 */

function unique(prefix: string): string {
  return `${prefix} ${Date.now()}`;
}

/**
 * A name as a LITERAL pattern.
 *
 * `new RegExp(name)` treats the name as a pattern, so an item called "Monitor (27 inch)" produced a
 * capture group and matched a name without the brackets — which is to say it matched nothing on
 * screen. Escaping is the fix; renaming the fixture to dodge it would have left the trap for the next
 * person who used a bracket.
 */
function startsWith(name: string): RegExp {
  return new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
}

test.describe('service catalog', () => {
  test('publishes an item, and somebody can then request it', async ({ page }) => {
    const name = unique('E2E Laptop replacement');
    await gotoInShell(page, '/catalog');

    // The empty-state CTA and the header CTA are the same action; whichever is on screen must work.
    const publish = page.getByRole('button', { name: /publish (an|the first) item/i }).first();
    await expect(publish).toBeVisible();
    await publish.click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Name').fill(name);
    await dialog.getByLabel('Description').fill('Replaced every three years, or sooner if broken.');
    await dialog.getByLabel('Category').selectOption('hardware');
    /*
     * The approver permission is a SELECT over the real permission catalogue, not a text box. It used
     * to be required with a free-text value and a default of `requests.approve` — a code that does not
     * exist in the catalogue at all — so the field invited a value nothing would ever match.
     */
    await dialog.getByLabel('Approver permission').selectOption('catalog.approve');
    await dialog.getByLabel('Decision target (hours)').fill('24');
    await dialog.getByRole('button', { name: /^Publish$/ }).click();
    await expect(dialog).toBeHidden({ timeout: 15_000 });

    // It is in the catalog, in its category, with the decision target rendered as a target for a
    // DECISION rather than as an SLA on delivery — fulfilment is manual once approved.
    /*
     * ANCHORED. The card, the Edit action and the Remove action all carry the item's name in their
     * accessible name — so an unanchored pattern matched three elements and Playwright's strict mode
     * refused, correctly. `^` picks the card, whose name starts with the item's.
     */
    const card = page.getByRole('button', { name: startsWith(name) });
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card).toContainText('Decision within 24h');

    // And the published item is requestable, which is the whole point of publishing it.
    await card.click();
    const requestDialog = page.getByRole('dialog');
    await expect(requestDialog).toBeVisible();
    await requestDialog
      .getByRole('textbox')
      .fill('Mine will not hold a charge for more than an hour.');
    await requestDialog
      .getByRole('button', { name: /submit|request/i })
      .last()
      .click();
    await expect(requestDialog).toBeHidden({ timeout: 15_000 });
  });

  test('edits an item, and removes it again', async ({ page }) => {
    /*
     * The other three verbs of the four. `PATCH` and `DELETE` had no caller either, so an item
     * published with a typo was permanent and a service withdrawn from the business stayed on the
     * page for ever.
     */
    const name = unique('E2E Monitor');
    await gotoInShell(page, '/catalog');
    await page
      .getByRole('button', { name: /publish (an|the first) item/i })
      .first()
      .click();

    let dialog = page.getByRole('dialog');
    await dialog.getByLabel('Name').fill(name);
    await dialog.getByLabel('Approver permission').selectOption('catalog.approve');
    await dialog.getByRole('button', { name: /^Publish$/ }).click();
    await expect(dialog).toBeHidden({ timeout: 15_000 });

    const renamed = `${name} (27 inch)`;
    await page.getByRole('button', { name: `Edit ${name}` }).click();
    dialog = page.getByRole('dialog');
    await dialog.getByLabel('Name').fill(renamed);
    await dialog.getByRole('button', { name: /^Save$/ }).click();
    await expect(dialog).toBeHidden({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: startsWith(renamed) })).toBeVisible({
      timeout: 15_000,
    });

    await page.getByRole('button', { name: `Remove ${renamed}` }).click();
    const confirm = page.getByRole('alertdialog');
    await expect(confirm).toBeVisible();
    // The confirm names the consequence: a hard delete, and requests already raised are unaffected.
    await expect(confirm).toContainText(/cannot be undone/i);
    await confirm.getByRole('button', { name: /^Remove$/ }).click();

    // Gone from the grid entirely: the card AND its two actions.
    await expect(page.getByRole('button', { name: startsWith(renamed) })).toHaveCount(0, {
      timeout: 15_000,
    });
  });
});
