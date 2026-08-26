import { test } from './support/test';
import type { APIRequestContext } from '@playwright/test';
import {
  chooseFromPicker,
  createRisk,
  csrfHeaders,
  expect,
  expectRowSomewhere,
  gotoInShell,
  myEmployeeId,
} from './support/fixtures';

/**
 * The information-asset register and the supplier register — the two ISMS screens whose rules live in
 * REFERENCE DATA rather than in code.
 *
 * WHAT THIS PINS THAT NOTHING ELSE CAN
 * ------------------------------------
 * - a classification's handling rules and encryption requirement come from the API's own level table and
 *   are shown where the choice is made, so a policy edit lands in the form
 * - LOWERING a classification is a different act from raising it: a different endpoint, a different
 *   permission (`information_asset.declassify`), and the dialog says which one it is about to do
 * - every classification change is appended with its reason, so the register answers "when did this become
 *   restricted and who said so"
 * - CORRECTING an entry is the way past a reclassification the rating refuses: `restricted` needs a
 *   confidentiality of at least 4, and the correction form is the only screen that can move a rating — so
 *   refused, corrected, accepted is walked in one test, since either half alone proves nothing
 * - the asset-to-device link is readable in BOTH directions, and the count on the row moves with it
 * - retirement ends the changes, not the row: the entry keeps its history and its links, stops offering
 *   every action the API would refuse, and stays reachable behind a filter
 * - a supplier is registered PROSPECTIVE and activating it needs `vendor.approve`, not `vendor.manage`
 * - `pass_with_conditions` demands its conditions, because a conditional pass with nothing written down is
 *   just a pass
 * - the register's red "No DPA" finding is the WAY IN to recording the agreement, not a dead end: the
 *   field was settable on the API and present in no form, so the screen named a GDPR Article 28(3) gap
 *   nobody could close from here
 */

function unique(prefix: string): string {
  return `${prefix}-${Date.now()}`;
}

/** An asset at a chosen classification, through the API. */
async function registerAsset(
  request: APIRequestContext,
  reference: string,
  classification: 'public' | 'internal' | 'confidential' | 'restricted',
  /**
   * THE LABEL HAS TO MATCH THE ASSESSMENT. The API refuses a `restricted` asset whose confidentiality
   * rating is below 4 — "the label was applied without the assessment agreeing" — which is the rule this
   * spec learned by breaking it. Passed in so a test that will reclassify UPWARDS starts with a rating
   * that supports the destination.
   */
  confidentiality = 3,
  /**
   * Personal data cannot be classified below `confidential`. So a test that deliberately starts at
   * `internal` has to turn this off, or the registration is refused for a reason it was not about.
   */
  personalData = true,
): Promise<{ id: string; reference: string }> {
  const ownerId = await myEmployeeId(request);
  const res = await request.post('/v1/information-assets', {
    headers: await csrfHeaders(request),
    data: {
      reference,
      name: `Playwright asset ${reference}`,
      type: 'dataset',
      classification,
      classificationReason: 'Created by an e2e spec.',
      ownerId,
      confidentiality,
      integrity: 3,
      availability: 3,
      personalData,
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const body = (await res.json()) as { data?: { id: string }; id?: string };
  return { id: body.data?.id ?? body.id!, reference };
}

/** A hardware asset to hold data, through the API. */
async function registerDevice(
  request: APIRequestContext,
  assetTag: string,
): Promise<{ id: string; assetTag: string }> {
  const res = await request.post('/v1/assets', {
    headers: await csrfHeaders(request),
    // `model` is set because the picker's hint line reads it, and a hint that renders `undefined` is a
    // defect this spec would otherwise walk straight past.
    data: { assetTag, type: 'laptop', manufacturer: 'Playwright', model: 'Spec 13' },
  });
  expect(res.status(), await res.text()).toBe(201);
  const body = (await res.json()) as { data?: { id: string }; id?: string };
  return { id: body.data?.id ?? body.id!, assetTag };
}

test.describe('information assets', () => {
  test('registers an asset, showing the handling rules the level carries', async ({ page }) => {
    const reference = unique('PWA').toUpperCase();
    await gotoInShell(page, '/information-assets');

    await page.getByRole('button', { name: /register an asset/i }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    await dialog.getByLabel('Reference').fill(reference);
    // ANCHORED LABELS. `FormField` appends `*` to a required field's accessible name, and plain substring
    // matching then finds more than one control: "Classification" also matches "Why this classification".
    await dialog.getByLabel(/^Name/).fill('Customer billing extract');
    await dialog.getByLabel(/^Classification/).selectOption('restricted');
    // THE POLICY'S OWN WORDS, from `/classification-levels` — not a string in this codebase. Restricted
    // requires encryption, and the form says so where the choice is made.
    await expect(dialog.getByText(/Encryption required/i)).toBeVisible();

    await dialog.getByLabel('Why this classification').fill('Contains cardholder data.');
    // `restricted` requires a confidentiality rating of at least 4: the classification is a claim the
    // assessment has to support, and the API refuses the pair when it does not.
    await dialog.getByLabel(/^Confidentiality/).selectOption('5');
    await chooseFromPicker(page, dialog, 'Owner', 'Admin');
    await dialog.getByRole('button', { name: /register asset/i }).click();
    await expect(dialog).toBeHidden();

    await expectRowSomewhere(page, reference);
    const row = page.locator('tbody tr', { hasText: reference });
    await expect(row).toContainText('Restricted');
    // The encryption flag travels with the classification, so the row shows it too.
    await expect(row).toContainText('encrypted');
    // Zero devices is a number, not a blank: nothing registered holds it yet.
    await expect(row).toContainText('0');
  });

  test('declassifying is a different act from reclassifying, and both are recorded', async ({
    page,
    request,
  }) => {
    const asset = await registerAsset(request, unique('PWD').toUpperCase(), 'confidential', 5);

    await gotoInShell(page, '/information-assets');
    await page.getByRole('searchbox').fill(asset.reference);
    const row = page.locator('tbody tr', { hasText: asset.reference });
    await expect(row).toBeVisible({ timeout: 15_000 });

    // UP first: the dialog offers to reclassify, in the ordinary way.
    await row.getByRole('button', { name: 'Reclassify' }).click();
    let dialog = page.getByRole('dialog');
    await dialog.getByLabel('New classification').selectOption('restricted');
    await expect(dialog.getByRole('button', { name: /^Reclassify$/ })).toBeVisible();
    await dialog.getByLabel('Reason').fill('Scope now includes payment identifiers.');
    await dialog.getByRole('button', { name: /^Reclassify$/ }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('tbody tr', { hasText: asset.reference })).toContainText(
      'Restricted',
      {
        timeout: 15_000,
      },
    );

    // DOWN second: same form, and it changes what it says it will do — because lowering a classification
    // removes protection and goes to the declassify endpoint under its own permission.
    await page
      .locator('tbody tr', { hasText: asset.reference })
      .getByRole('button', { name: 'Reclassify' })
      .click();
    dialog = page.getByRole('dialog');
    // Down to CONFIDENTIAL, not internal: the asset holds personal data, and the API refuses
    // "personal data cannot be classified 'internal' — it must be at least 'confidential'". Another rule
    // this spec learned by breaking it, and the right one to respect rather than route around.
    await dialog.getByLabel('New classification').selectOption('confidential');
    await expect(dialog.getByText(/LOWERING a classification removes protection/i)).toBeVisible();
    await expect(dialog.getByRole('button', { name: /^Declassify$/ })).toBeVisible();
    await dialog.getByLabel('Reason').fill('Payment identifiers removed from the extract.');
    await dialog.getByRole('button', { name: /^Declassify$/ }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('tbody tr', { hasText: asset.reference })).toContainText(
      'Confidential',
      { timeout: 15_000 },
    );

    // BOTH CHANGES ARE IN THE HISTORY, with the registration before them. That is the audit answer: not
    // what it is classified as, but when it became that and why.
    await page.locator('tbody tr', { hasText: asset.reference }).click();
    const drawer = page.getByRole('dialog');
    await expect(drawer.getByRole('heading', { name: 'Classification history' })).toBeVisible();
    await expect(drawer.getByText('registered as')).toBeVisible();
    await expect(drawer.getByText(/Payment identifiers removed/)).toBeVisible();
    await expect(drawer.getByText(/Scope now includes payment identifiers/)).toBeVisible();
  });

  /**
   * THE DEAD END, WALKED THROUGH THE UI.
   *
   * Reclassifying judges the NEW label against the CIA rating ALREADY STORED — `restricted` needs a
   * confidentiality of at least 4 — and `PATCH /v1/information-assets/:id` is the only route that can
   * move a rating. No screen called that route, so an asset registered `internal` at 3 could not be
   * raised to `restricted` from the product at all: the dialog 412'd and there was nowhere to go.
   *
   * The refusal and the success are one test on purpose. The refusal alone would still pass if
   * `restricted` were simply unreachable; the success alone would pass if the coherence rule had been
   * dropped. Together they say: refused for the stated reason, and the way out that the refusal
   * implies is actually reachable by clicking.
   */
  test('correcting the rating is the way past a reclassification the rating refuses', async ({
    page,
    request,
  }) => {
    const asset = await registerAsset(
      request,
      unique('PWC').toUpperCase(),
      'internal',
      3,
      // No personal data: at `internal` that pair is refused for a different reason, and a test that
      // can fail two ways cannot say which rule it was pinning.
      false,
    );

    await gotoInShell(page, '/information-assets');
    await page.getByRole('searchbox').fill(asset.reference);
    const row = () => page.locator('tbody tr', { hasText: asset.reference });
    await expect(row()).toBeVisible({ timeout: 15_000 });
    await expect(row()).toContainText('3·3·3');

    // 1. REFUSED, and the dialog hands over the API's own sentence — the label and the number it
    // wanted — rather than a sentence this screen invented about what might be wrong.
    await row().getByRole('button', { name: 'Reclassify' }).click();
    let dialog = page.getByRole('dialog', { name: `Reclassify ${asset.reference}` });
    await dialog.getByLabel('New classification').selectOption('restricted');
    await dialog.getByLabel('Reason').fill('Now in scope for the cardholder data environment.');
    await dialog.getByRole('button', { name: /^Reclassify$/ }).click();
    await expect(dialog.getByText(/confidentiality rating of at least 4/i)).toBeVisible();
    await expect(row()).toContainText('Internal');
    await dialog.getByRole('button', { name: 'Cancel' }).click();

    // 2. CORRECT THE RATING — the reassessment the refusal was asking for, on the register form
    // serving `PATCH` instead of `POST`.
    await row().getByRole('button', { name: 'Correct' }).click();
    dialog = page.getByRole('dialog', { name: `Correct ${asset.reference}` });
    // It opened on THIS entry's values, not on the register form's defaults. A correction form seeded
    // with blanks would silently wipe every field the user did not retype.
    await expect(dialog.getByLabel(/^Name/)).toHaveValue(`Playwright asset ${asset.reference}`);
    // The reference is read-only: risk assessments and the classification history quote it.
    await expect(dialog.getByLabel('Reference')).toBeDisabled();
    /*
     * AND THE CLASSIFICATION IS NOT ON OFFER HERE. `UpdateInformationAssetSchema` omits it and its
     * reason, because changing a label appends a history row and lowering it needs
     * `information_asset.declassify`. If this form grew the field, a label could move with no history
     * and no permission check — so its absence is asserted, and so is the note that says where to go
     * instead.
     */
    await expect(dialog.getByLabel(/^Classification/)).toHaveCount(0);
    await expect(dialog.getByLabel('Why this classification')).toHaveCount(0);
    await expect(dialog.getByText(/Changing that is a reclassification/i)).toBeVisible();

    await dialog.getByLabel(/^Confidentiality/).selectOption('5');
    await dialog.getByRole('button', { name: /save correction/i }).click();
    await expect(dialog).toBeHidden();
    await expect(row()).toContainText('5·3·3', { timeout: 15_000 });
    // Still `internal`. A re-rating is not a reclassification — and if it were, step 3 would be
    // proving nothing.
    await expect(row()).toContainText('Internal');

    // 3. NOW IT GOES THROUGH, through the same dialog that refused it.
    await row().getByRole('button', { name: 'Reclassify' }).click();
    dialog = page.getByRole('dialog', { name: `Reclassify ${asset.reference}` });
    await dialog.getByLabel('New classification').selectOption('restricted');
    await dialog.getByLabel('Reason').fill('Now in scope for the cardholder data environment.');
    await dialog.getByRole('button', { name: /^Reclassify$/ }).click();
    await expect(dialog).toBeHidden();
    await expect(row()).toContainText('Restricted', { timeout: 15_000 });
  });

  test('links a device, reads the register backwards from it, then unlinks', async ({
    page,
    request,
  }) => {
    const asset = await registerAsset(request, unique('PWL').toUpperCase(), 'confidential', 5);
    const device = await registerDevice(request, unique('LT').toUpperCase());

    await gotoInShell(page, '/information-assets');
    await page.getByRole('searchbox').fill(asset.reference);
    const row = page.locator('tbody tr', { hasText: asset.reference });
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.click();

    const drawer = page.getByRole('dialog', { name: `Playwright asset ${asset.reference}` });
    await expect(drawer.getByRole('heading', { name: 'Devices (0)' })).toBeVisible();

    await chooseFromPicker(page, drawer, 'Device to link', device.assetTag);
    await expect(drawer.getByText(device.assetTag)).toBeVisible({ timeout: 15_000 });
    /*
     * THE COUNT IN THE HEADING MOVES. It is `deviceCount` off the list row, and the drawer reads that row
     * back out of the list rather than holding the copy it was opened with — so a snapshot would leave the
     * heading saying "Devices (0)" directly above the device just added to it.
     */
    await expect(drawer.getByRole('heading', { name: 'Devices (1)' })).toBeVisible({
      timeout: 15_000,
    });

    // THE SAME LINK, READ BACKWARDS: not "where is this data" but "what is on that machine".
    await drawer.getByRole('button', { name: `What ${device.assetTag} holds` }).click();
    const report = page.getByRole('dialog', { name: 'What a device holds' });
    // `exact`, because the report shows the NAME above the reference and `registerAsset` builds the name
    // out of the reference — a substring match resolves to both lines.
    await expect(report.getByText(asset.reference, { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    // The triage line an incident starts from: how much, and how bad the worst of it is.
    await expect(report.getByText(/1 registered asset/)).toBeVisible();
    await expect(report.getByText('Confidential').first()).toBeVisible();
    // Personal data is what turns a lost laptop into a breach assessment; `registerAsset` sets it.
    await expect(report.getByText(/1 hold personal data/)).toBeVisible();

    /*
     * ONE KEYPRESS, ONE OVERLAY. The report closes and the drawer behind it stays open. Escape used to be
     * decided by document order, and pages render their dialogs BEFORE the drawer — so the drawer claimed
     * the key and this left the report open over nothing.
     */
    await page.keyboard.press('Escape');
    await expect(report).toBeHidden();
    await expect(drawer.getByRole('heading', { name: 'Devices (1)' })).toBeVisible();

    await drawer.getByRole('button', { name: `Unlink ${device.assetTag}` }).click();
    await expect(drawer.getByRole('heading', { name: 'Devices (0)' })).toBeVisible({
      timeout: 15_000,
    });
    await expect(drawer.getByText('Not held on any registered device')).toBeVisible();
  });

  test('retiring ends the changes but keeps the entry', async ({ page, request }) => {
    const asset = await registerAsset(request, unique('PWR').toUpperCase(), 'confidential', 5);
    const device = await registerDevice(request, unique('LT').toUpperCase());
    // Linked through the API, so the assertion below is about retirement KEEPING the link rather than
    // about this spec having managed to create one.
    const linked = await request.put(`/v1/information-assets/${asset.id}/devices/${device.id}`, {
      headers: await csrfHeaders(request),
    });
    expect(linked.status(), await linked.text()).toBe(204);

    await gotoInShell(page, '/information-assets');
    await page.getByRole('searchbox').fill(asset.reference);
    await expect(page.locator('tbody tr', { hasText: asset.reference })).toBeVisible({
      timeout: 15_000,
    });
    await page.locator('tbody tr', { hasText: asset.reference }).click();

    const drawer = page.getByRole('dialog', { name: `Playwright asset ${asset.reference}` });
    // RETIRING LIVES IN THE DRAWER, because it is the one act here that cannot be undone and the drawer is
    // where somebody has actually read the entry.
    await drawer.getByRole('button', { name: 'Retire' }).click();
    const confirm = page.getByRole('alertdialog');
    // The API's own preconditions, said BEFORE the act instead of arriving as a 412 afterwards.
    await expect(
      confirm.getByText(/with its classification history and its device links/i),
    ).toBeVisible();
    /*
     * AND THE CONFIRMATION IS ON TOP OF THE DRAWER IT CAME FROM. Both used `z-50`, so stacking fell to DOM
     * order — pages render their dialogs before the drawer — and the drawer panel painted ABOVE the
     * confirmation's backdrop: still lit, still clickable, guarding nothing while a decision was pending.
     *
     * A trial click is the assertion: it runs Playwright's actionability check and clicks nothing, so it
     * fails exactly when the backdrop is NOT intercepting.
     */
    await expect(
      drawer.getByRole('button', { name: 'Reclassify' }).click({ trial: true, timeout: 2_000 }),
    ).rejects.toThrow();
    await confirm.getByRole('button', { name: /retire asset/i }).click();

    // Out of the register, because the register means the CURRENT inventory — and the drawer closes with
    // it, since it reads the row out of the list.
    await expect(page.locator('tbody tr', { hasText: asset.reference })).toHaveCount(0, {
      timeout: 15_000,
    });
    await expect(drawer).toBeHidden();

    // STILL THERE, though. A retired row that could not be found again would be indistinguishable from a
    // delete, and a risk assessment from last year still points at it.
    await page.getByRole('button', { name: 'Include retired' }).click();
    const retired = page.locator('tbody tr', { hasText: asset.reference });
    await expect(retired).toBeVisible({ timeout: 15_000 });
    await expect(retired).toContainText('Retired');
    // AND IT OFFERS NOTHING. Every action the API refuses on a retired asset is absent rather than present
    // and failing.
    await expect(retired.getByRole('button', { name: 'Reclassify' })).toHaveCount(0);
    await expect(retired.getByRole('button', { name: 'Reviewed' })).toHaveCount(0);
    // Correcting included: `update` calls `assertNotRetired` first, so the form could only ever come
    // back with "is retired and accepts no further changes".
    await expect(retired.getByRole('button', { name: 'Correct' })).toHaveCount(0);

    await retired.click();
    const retiredDrawer = page.getByRole('dialog', {
      name: `Playwright asset ${asset.reference}`,
    });
    await expect(retiredDrawer.getByRole('button', { name: 'Retire' })).toHaveCount(0);
    // The link SURVIVED, and cannot be added to: `linkDevice` refuses a retired asset, `unlinkDevice` does
    // not — so the picker goes and the unlink stays.
    await expect(retiredDrawer.getByRole('heading', { name: 'Devices (1)' })).toBeVisible();
    await expect(retiredDrawer.getByText(/no new device can be recorded/)).toBeVisible();
    await expect(retiredDrawer.getByRole('combobox', { name: 'Device to link' })).toHaveCount(0);
    await expect(
      retiredDrawer.getByRole('button', { name: `Unlink ${device.assetTag}` }),
    ).toBeVisible();
  });
});

test.describe('suppliers', () => {
  test('registers a supplier as prospective, then activates it', async ({ page }) => {
    const reference = unique('PWS').toUpperCase();
    await gotoInShell(page, '/vendors');

    await page.getByRole('button', { name: /register a supplier/i }).click();
    let dialog = page.getByRole('dialog');
    await expect(dialog.getByText(/Registered as PROSPECTIVE/i)).toBeVisible();

    await dialog.getByLabel('Reference').fill(reference);
    await dialog.getByLabel('Criticality').selectOption('critical');
    // CRITICALITY IS A SCHEDULE, and the level's own interval is shown when it is chosen.
    await expect(dialog.getByText(/Reassessed every \d+ months/)).toBeVisible();
    await dialog.getByLabel(/^Name/).fill('Acme Cloud');
    await dialog.getByLabel('Services').fill('Hosting for the billing platform.');
    await chooseFromPicker(page, dialog, 'Owner', 'Admin');
    await dialog.getByRole('button', { name: /register supplier/i }).click();
    await expect(dialog).toBeHidden();

    await page.getByRole('searchbox').fill(reference);
    const row = page.locator('tbody tr', { hasText: reference });
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row).toContainText('Prospective');
    // Never assessed is named rather than blank — it is what the review-gap report is about.
    await expect(row).toContainText('Never');
    // AND THEREFORE NO ACTIVATE BUTTON. The API refuses activation for an unassessed supplier
    // (`VENDOR_ASSESSMENT_REQUIRED`), so the screen offers the assessment instead of an action that can
    // only fail. This assertion is the gate; the rest of the test walks through it.
    await expect(row.getByRole('button', { name: 'Activate' })).toHaveCount(0);

    await row.getByRole('button', { name: 'Assess' }).click();
    dialog = page.getByRole('dialog');
    await dialog.getByLabel('Scope').fill('ISO 27001 certificate and the hosting DPA.');
    await dialog.getByRole('button', { name: /record assessment/i }).click();
    await expect(dialog).toBeHidden();

    // Activating is `vendor.approve`, and it is a confirmation because it accepts the dependency.
    await expect(
      page.locator('tbody tr', { hasText: reference }).getByRole('button', { name: 'Activate' }),
    ).toBeVisible({ timeout: 15_000 });
    await page
      .locator('tbody tr', { hasText: reference })
      .getByRole('button', { name: 'Activate' })
      .click();
    const confirm = page.getByRole('alertdialog');
    await expect(confirm.getByText(/Accepts the dependency/i)).toBeVisible();
    await confirm.getByRole('button', { name: /^Activate$/ }).click();
    await expect(page.locator('tbody tr', { hasText: reference })).toContainText('Active', {
      timeout: 15_000,
    });
  });

  test('a conditional pass demands its conditions', async ({ page, request }) => {
    // `pass_with_conditions` exists so that a pass which owes something is not recorded as a clean pass.
    // The conditions field appears WITH that outcome and is required, because the conditions are the
    // difference between the two.
    const reference = unique('PWV').toUpperCase();
    const ownerId = await myEmployeeId(request);
    const created = await request.post('/v1/vendors', {
      headers: await csrfHeaders(request),
      data: {
        reference,
        name: `Playwright supplier ${reference}`,
        services: 'Created by an e2e spec.',
        criticality: 'high',
        ownerId,
      },
    });
    expect(created.status(), await created.text()).toBe(201);

    await gotoInShell(page, '/vendors');
    await page.getByRole('searchbox').fill(reference);
    const row = page.locator('tbody tr', { hasText: reference });
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.getByRole('button', { name: 'Assess' }).click();

    const dialog = page.getByRole('dialog');
    // A high-criticality supplier needs INDEPENDENT evidence, and that comes from the level table.
    await expect(dialog.getByText(/INDEPENDENT evidence/i)).toBeVisible();

    // A plain pass has no conditions field at all.
    await expect(dialog.getByLabel('Conditions')).toHaveCount(0);

    await dialog.getByLabel('Outcome').selectOption('pass_with_conditions');
    await expect(dialog.getByLabel('Conditions')).toBeVisible();
    await expect(dialog.getByLabel('Conditions')).toHaveAttribute('required', '');

    await dialog.getByLabel('Scope').fill('SOC 2 Type II report for the hosting platform.');
    await dialog
      .getByLabel('Conditions')
      .fill('Provide the penetration-test summary within 30 days.');
    await dialog.getByRole('button', { name: /record assessment/i }).click();
    await expect(dialog).toBeHidden();

    await expect(page.locator('tbody tr', { hasText: reference })).toContainText(
      'Pass with conditions',
      { timeout: 15_000 },
    );

    // The conditions are on the assessment, where the next person looks for them.
    await page.locator('tbody tr', { hasText: reference }).click();
    const drawer = page.getByRole('dialog');
    await expect(drawer.getByRole('heading', { name: 'Assessments' })).toBeVisible();
    await expect(
      drawer.getByText(/Conditions: Provide the penetration-test summary/),
    ).toBeVisible();
  });

  test('links a register risk to a supplier, and the count follows', async ({ page, request }) => {
    const reference = unique('PWL').toUpperCase();
    const ownerId = await myEmployeeId(request);
    const created = await request.post('/v1/vendors', {
      headers: await csrfHeaders(request),
      data: {
        reference,
        name: `Playwright supplier ${reference}`,
        services: 'Created by an e2e spec.',
        // CRITICAL, because the empty state on this panel is a FINDING at this tier — the same gap
        // `/reports/critical-without-risk` names from the other side.
        criticality: 'critical',
        ownerId,
      },
    });
    expect(created.status(), await created.text()).toBe(201);
    const risk = await createRisk(request, unique('PWK').toUpperCase(), 4, 5);

    await gotoInShell(page, '/vendors');
    await page.getByRole('searchbox').fill(reference);
    const row = page.locator('tbody tr', { hasText: reference });
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.click();

    const drawer = page.getByRole('dialog', { name: `Playwright supplier ${reference}` });
    await expect(drawer.getByRole('heading', { name: 'Risks (0)' })).toBeVisible();
    // The absence is named as the gap it is, not as an empty list.
    await expect(
      drawer.getByText(/a supplier at this criticality with nothing in the register/),
    ).toBeVisible();

    /*
     * SEARCHED BY THE SERVER. The picker is fed by `/v1/risks?search=`, which this branch added — the term
     * here is the risk's REFERENCE, which the picker shows as its hint and the API matches. A client-side
     * filter over one page would have found this risk today and stopped finding it once the register grew
     * past the page limit.
     */
    await chooseFromPicker(page, drawer, 'Risk to link', risk.reference);
    // `exact`, because the row shows the TITLE under the reference and `createRisk` builds the title out of
    // the reference — a substring match resolves to both lines.
    await expect(drawer.getByText(risk.reference, { exact: true })).toBeVisible({
      timeout: 15_000,
    });

    /*
     * THE COUNT IN THE HEADING MOVES. It is `riskCount` off the list row, and the drawer reads that row back
     * out of the list rather than holding the copy it was opened with — a snapshot would leave the heading
     * saying "Risks (0)" directly above the risk just added to it.
     */
    await expect(drawer.getByRole('heading', { name: 'Risks (1)' })).toBeVisible({
      timeout: 15_000,
    });
    // The status and the score come back too. The FE type used to be the CONTROLS route's three-field
    // schema, which was assignable and silently hid both.
    await expect(drawer.getByText('Identified')).toBeVisible();
    await expect(drawer.getByText('20', { exact: true })).toBeVisible();

    await drawer.getByRole('button', { name: `Unlink ${risk.reference}` }).click();
    await expect(drawer.getByRole('heading', { name: 'Risks (0)' })).toBeVisible({
      timeout: 15_000,
    });
  });

  /**
   * THE LOUDEST FINDING ON THE REGISTER, AND IT USED TO GO NOWHERE.
   *
   * `dataProcessingAgreementId` has always been settable on `POST /v1/vendors` and
   * `PATCH /v1/vendors/:id`, and appeared in no form at all — while the row rendered a red "No DPA" and
   * the drawer said "Yes — NO DPA recorded". So the screen shouted about a GDPR Article 28(3) gap that
   * the product gave nobody a way to close, and the supplier could never be activated either, because
   * the API refuses a live processor without an agreement.
   *
   * THE FINDING IS ASSERTED BEFORE IT IS CLEARED. A test that only checked for "DPA on file" at the end
   * would pass just as happily against a register that never produced the finding in the first place —
   * and then the fix would be verified against nothing.
   */
  test('the red "No DPA" finding is the way to record the agreement', async ({ page, request }) => {
    const reference = unique('PWD').toUpperCase();
    const code = unique('PW-DPA').toUpperCase();
    const ownerId = await myEmployeeId(request);

    // The agreement is a CONTROLLED DOCUMENT, chosen the same way an audit's report and a review's
    // minutes are — so the spec creates a real one to pick rather than pretending a uuid box is fine.
    const document = await request.post('/v1/documents', {
      headers: await csrfHeaders(request),
      data: {
        code,
        title: `Playwright data processing agreement ${code}`,
        category: 'contract_template',
        ownerId,
      },
    });
    expect(document.status(), await document.text()).toBe(201);

    const created = await request.post('/v1/vendors', {
      headers: await csrfHeaders(request),
      data: {
        reference,
        name: `Playwright supplier ${reference}`,
        services: 'Created by an e2e spec.',
        criticality: 'high',
        ownerId,
        // A processor with no agreement recorded: exactly the state the register flags, and the normal
        // order of events, which is why the CHECK is scoped to `active` rather than to registration.
        dataProcessor: true,
      },
    });
    expect(created.status(), await created.text()).toBe(201);

    await gotoInShell(page, '/vendors');
    await page.getByRole('searchbox').fill(reference);
    const row = () => page.locator('tbody tr', { hasText: reference });
    await expect(row()).toBeVisible({ timeout: 15_000 });

    // THE FINDING, and it is a CONTROL rather than a label — `getByRole('button')` is the assertion.
    // Rendered as a plain badge without `vendor.manage` or on a terminated supplier, because there is
    // nothing to click through to in either case.
    const finding = row().getByRole('button', { name: 'No DPA' });
    await expect(finding).toBeVisible();
    await finding.click();

    const dialog = page.getByRole('dialog');
    // One form, two verbs: the register form in its correcting mode, named after the entry it is about.
    await expect(dialog.getByRole('heading', { name: `Correct ${reference}` })).toBeVisible();
    // The reference is locked. Assessments, risk links and both spend reports quote it, so
    // `UpdateVendorSchema` omits it — and a field the API rejects outright must not look editable.
    await expect(dialog.getByLabel('Reference')).toBeDisabled();
    /*
     * AND THE FORM OPENED ON THE FIELD THE FINDING WAS ABOUT. This is what makes the badge a route
     * rather than a shortcut to a form with eleven inputs: `Modal` focuses the requested control instead
     * of the first one. Without it the reader lands on the close button and has to hunt.
     */
    await expect(dialog.getByLabel('Data processing agreement')).toBeFocused();

    await chooseFromPicker(page, dialog, 'Data processing agreement', code);
    await dialog.getByRole('button', { name: /save correction/i }).click();
    await expect(dialog).toBeHidden();

    // The finding is gone from the row, and specifically replaced by the positive statement — a blank
    // cell would mean the processor flag had been lost along with the gap.
    await expect(row()).toContainText('DPA on file', { timeout: 15_000 });
    await expect(row().getByRole('button', { name: 'No DPA' })).toHaveCount(0);

    // And in the drawer, which rendered the same gap in words.
    await row().click();
    const drawer = page.getByRole('dialog', { name: `Playwright supplier ${reference}` });
    await expect(drawer.getByText('Yes — DPA on file')).toBeVisible();
  });
});
