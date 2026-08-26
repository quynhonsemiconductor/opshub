import { test } from './support/test';
import type { APIRequestContext } from '@playwright/test';
import {
  chooseFromPicker,
  createRisk,
  csrfHeaders,
  expect,
  expectRowSomewhere,
  gotoInShell,
} from './support/fixtures';

/**
 * Security incidents: the lifecycle, the timeline the transitions write, and the breach clock.
 *
 * WHAT THIS PINS THAT NOTHING ELSE CAN
 * ------------------------------------
 * - the state machine as a USER meets it: each state offers exactly the moves it allows, and the one it
 *   forbids is absent rather than offered-and-refused
 * - `false_positive` is unreachable after containment — containment is evidence it was real, and both the
 *   service and `ck_incident_false_positive` say so
 * - every status change appends to the timeline WITHOUT anybody logging it, because the transition writes
 *   the entry in its own transaction
 * - a personal-data breach carries a 72-hour deadline the API computes, and the row says which of three
 *   states it is in: not a breach, due, or notified
 * - THE RECORD IS CORRECTABLE while it is still being handled, through the same form that reported it —
 *   and the action is absent, not merely refused, once the record is finished
 *
 * Everything asserted here is created here — the register is shared with the API suites.
 */

function unique(prefix: string): string {
  return `${prefix}-${Date.now()}`;
}

/** A reported incident, through the API, so a spec can start from the state it needs. */
async function reportIncident(
  request: APIRequestContext,
  reference: string,
  options: { personalDataBreach?: boolean; detectedAt?: string } = {},
): Promise<{ id: string; reference: string }> {
  const res = await request.post('/v1/incidents/report', {
    headers: await csrfHeaders(request),
    data: {
      reference,
      title: `Playwright incident ${reference}`,
      description: 'Created by an e2e spec so the register has something to handle.',
      category: 'Phishing',
      severity: 'high',
      detectedAt: options.detectedAt ?? new Date().toISOString(),
      personalDataBreach: options.personalDataBreach ?? false,
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const body = (await res.json()) as { data?: { id: string }; id?: string };
  return { id: body.data?.id ?? body.id!, reference };
}

test.describe('incidents', () => {
  test('reports an incident, and the breach checkbox names the clock it starts', async ({
    page,
  }) => {
    const reference = unique('PWI').toUpperCase();
    await gotoInShell(page, '/incidents');

    await page.getByRole('button', { name: /report an incident/i }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    // The 72 hours are NAMED in the form, because ticking this box is what starts them.
    await expect(dialog.getByText(/72-hour notification clock/i)).toBeVisible();
    /*
     * AND NO LINK FIELDS, which is the one way this form differs from the correction form it shares its
     * code with. `/v1/risks` and `/v1/assets` need `risk.read` and `asset.read`, while reporting needs
     * nothing at all — so for the person the ungated form exists for those two pickers would be empty
     * boxes. Which register risk an incident realised is a triage judgement, made later, by somebody
     * holding the register.
     */
    await expect(dialog.getByLabel('Linked risk')).toHaveCount(0);
    await expect(dialog.getByLabel('Affected device')).toHaveCount(0);

    await dialog.getByLabel('Reference').fill(reference);
    await dialog.getByLabel('Category').fill('Phishing');
    await dialog.getByLabel('Title').fill('Credential-harvesting email opened in Finance');
    await dialog
      .getByLabel('What happened')
      .fill('Two people entered credentials on a fake portal.');
    await dialog.getByLabel('Severity').selectOption('critical');
    // TWO HOURS AGO, in the browser's own zone. A future detection time is refused ("an incident cannot
    // be detected in the future"), which is right — and it is why this is computed rather than a literal:
    // any fixed date is either in the future today or drifts into the distant past.
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const localDateTime = new Date(twoHoursAgo.getTime() - twoHoursAgo.getTimezoneOffset() * 60_000)
      .toISOString()
      .slice(0, 16);
    await dialog.getByLabel('Detected at').fill(localDateTime);
    await dialog.getByRole('button', { name: /report incident/i }).click();
    await expect(dialog).toBeHidden();

    await expectRowSomewhere(page, reference);
    const row = page.locator('tbody tr', { hasText: reference });
    await expect(row).toContainText('Critical');
    await expect(row).toContainText('Reported');
    // Not a breach, and the column says so rather than leaving a blank that could mean "not yet decided".
    await expect(row).toContainText('No');
  });

  test('offers only the moves the state allows, and writes each one to the timeline', async ({
    page,
    request,
  }) => {
    const incident = await reportIncident(request, unique('PWL').toUpperCase());

    await gotoInShell(page, '/incidents');
    await expectRowSomewhere(page, incident.reference);
    const row = page.locator('tbody tr', { hasText: incident.reference });

    // REPORTED: triage or dismiss. Containing is two steps away and is not offered.
    await expect(row.getByRole('button', { name: 'Triage' })).toBeVisible();
    await expect(row.getByRole('button', { name: 'Dismiss' })).toBeVisible();
    await expect(row.getByRole('button', { name: 'Contain' })).toHaveCount(0);
    await expect(row.getByRole('button', { name: 'Resolve' })).toHaveCount(0);

    await row.getByRole('button', { name: 'Triage' }).click();
    let dialog = page.getByRole('dialog');
    await chooseFromPicker(page, dialog, 'Assign to', 'Admin');
    await dialog.getByRole('button', { name: /^Triage$/ }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('tbody tr', { hasText: incident.reference })).toContainText(
      'Triaged',
      {
        timeout: 15_000,
      },
    );

    // TRIAGED: contain or dismiss.
    const triaged = page.locator('tbody tr', { hasText: incident.reference });
    await expect(triaged.getByRole('button', { name: 'Contain' })).toBeVisible();
    await expect(triaged.getByRole('button', { name: 'Triage' })).toHaveCount(0);

    await triaged.getByRole('button', { name: 'Contain' }).click();
    dialog = page.getByRole('dialog');
    // Says what containment costs: the false-positive exit closes.
    await expect(dialog.getByText(/cannot be dismissed as a false positive/i)).toBeVisible();
    await dialog.getByRole('button', { name: /mark contained/i }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('tbody tr', { hasText: incident.reference })).toContainText(
      'Contained',
      { timeout: 15_000 },
    );

    // CONTAINED: resolve only — dismissing is gone, which is the rule this test exists for.
    const contained = page.locator('tbody tr', { hasText: incident.reference });
    await expect(contained.getByRole('button', { name: 'Resolve' })).toBeVisible();
    await expect(contained.getByRole('button', { name: 'Dismiss' })).toHaveCount(0);

    // THE TIMELINE WROTE ITSELF. Nobody logged those two moves; the transitions did, in their own
    // transactions, which is why a timeline cannot be missing a step the status claims happened.
    await contained.click();
    const drawer = page.getByRole('dialog');
    await expect(drawer.getByRole('heading', { name: 'Timeline' })).toBeVisible();
    await expect(drawer.getByText('Status change').first()).toBeVisible();
    await expect(await drawer.getByText('Status change').count()).toBeGreaterThanOrEqual(2);
  });

  test('a personal-data breach shows its deadline, then shows it was notified', async ({
    page,
    request,
  }) => {
    // Detected 80 hours ago, so the 72-hour deadline has already passed and the banner has something to
    // report. The DEADLINE ITSELF is the API's: `notificationDueAt` comes from `detectedAt`, and
    // `hoursOverdue` from the report — this spec asserts on them rather than recomputing either.
    const detectedAt = new Date(Date.now() - 80 * 60 * 60 * 1000).toISOString();
    const incident = await reportIncident(request, unique('PWB').toUpperCase(), {
      personalDataBreach: true,
      detectedAt,
    });

    await gotoInShell(page, '/incidents');

    // The overdue banner appears only when something IS overdue, and names the hours.
    const banner = page.getByText(/past the 72-hour notification deadline/i);
    await expect(banner).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/h overdue/).first()).toBeVisible();

    await expectRowSomewhere(page, incident.reference);
    const row = page.locator('tbody tr', { hasText: incident.reference });
    await expect(row).toContainText('Due');

    // Recording the notification is a confirmation, not a form: backdating a regulator notification is
    // not something to offer.
    await row.click();
    const drawer = page.getByRole('dialog');
    await drawer.getByRole('button', { name: /regulator notified/i }).click();
    const confirm = page.getByRole('alertdialog');
    await expect(confirm.getByText(/not something to record before/i)).toBeVisible();
    await confirm.getByRole('button', { name: /record notification/i }).click();

    await expect(page.locator('tbody tr', { hasText: incident.reference })).toContainText(
      'Notified',
      { timeout: 15_000 },
    );

    /*
     * AND THE BREACH FLAG IS NOW LOCKED, which the API does not enforce and cannot.
     * `UpdateIncidentSchema` accepts `personalDataBreach: false` on an incident whose regulator has
     * already been notified, and nothing refuses it: the incident would drop off the overdue report and
     * out of the 72-hour arithmetic while `regulatorNotifiedAt` still records that a regulator was told
     * about a breach — a record contradicting itself, with no route to un-notify. Correcting a wrongly
     * ticked breach is one of the reasons the correction form exists, so it stays available right up to
     * the notification and stops there, and this is the only assertion that holds that line.
     */
    await page.keyboard.press('Escape');
    await expectRowSomewhere(page, incident.reference);
    await page
      .locator('tbody tr', { hasText: incident.reference })
      .getByRole('button', { name: 'Correct' })
      .click();
    const correction = page.getByRole('dialog');
    await expect(
      correction.getByLabel(/personal data was or may have been exposed/i),
    ).toBeDisabled();
    await expect(correction.getByText(/can no longer be withdrawn/i)).toBeVisible();
  });

  test('corrects a mis-graded severity and links the risk it realised', async ({
    page,
    request,
  }) => {
    /*
     * WHY THIS TEST EXISTS. `PATCH /v1/incidents/:id` shipped with the module and no screen called it, so
     * the severity somebody chose in the first ten minutes of a response was the severity for ever — and
     * severity is what the response queue is ORDERED by, so a critical filed as high sits below things
     * that matter less. The same PATCH is the only way to set `riskId`, which is the ISMS's feedback loop:
     * without it "the register said this could happen" can never be recorded against the incident proving
     * it did.
     *
     * A PRECISE INSTANT, seconds and milliseconds included, because the last assertion is about them.
     */
    const detectedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const incident = await reportIncident(request, unique('PWC').toUpperCase(), { detectedAt });
    const risk = await createRisk(request, unique('PWCR').toUpperCase(), 3, 3);

    await gotoInShell(page, '/incidents');
    await expectRowSomewhere(page, incident.reference);
    await page
      .locator('tbody tr', { hasText: incident.reference })
      .getByRole('button', { name: 'Correct' })
      .click();

    const dialog = page.getByRole('dialog');
    await expect(
      dialog.getByRole('heading', { name: `Correct ${incident.reference}` }),
    ).toBeVisible();

    /*
     * PREFILLED FROM THE RECORD. A correction that opened blank would be a re-entry form: every field
     * left alone would be sent empty, so fixing the severity would erase the description a regulator may
     * read. `high` is what the API holds.
     */
    await expect(dialog.getByLabel('Severity')).toHaveValue('high');

    /*
     * AND THE REFERENCE IS READ-ONLY. The post-incident report, the breach notification and any regulator
     * correspondence quote it, so renaming one would orphan every citation — which is why
     * `UpdateIncidentSchema` omits the field rather than making it optional. Disabled here, and the API
     * drops a reference sent anyway; this assertion is what keeps the screen from disagreeing with that.
     */
    const reference = dialog.getByLabel('Reference');
    await expect(reference).toBeDisabled();
    await expect(reference).toHaveValue(incident.reference);

    await dialog.getByLabel('Severity').selectOption('critical');
    await chooseFromPicker(page, dialog, 'Linked risk', risk.reference);
    await dialog.getByRole('button', { name: /save correction/i }).click();
    await expect(dialog).toBeHidden();

    /*
     * THE ROW A RESPONDER READS, REGRADED — and looked up from the start of the list again, because a
     * regrade MOVES it. The register is ordered worst-first, so `critical` jumps toward the front while
     * the viewer stays on whatever page the first lookup walked to. Asserted against the current page
     * alone this passed or failed depending on how many incidents the shared register happened to hold.
     */
    await expectRowSomewhere(page, incident.reference);
    await expect(page.locator('tbody tr', { hasText: incident.reference }).first()).toContainText(
      'Critical',
      { timeout: 15_000 },
    );

    const stored = await request.get(`/v1/incidents/${incident.id}`);
    expect(stored.ok(), await stored.text()).toBe(true);
    // `data` when the envelope is there and the body itself when it is not — same shape-tolerance as
    // `reportIncident` above, because the BFF unwraps single records and the API does not.
    const body = (await stored.json()) as { data?: Record<string, unknown> } & Record<
      string,
      unknown
    >;
    const record = body.data ?? body;
    expect(record.severity).toBe('critical');
    // The link the register could not record before — and the only place it can be set.
    expect(record.riskId).toBe(risk.id);
    /*
     * DETECTION UNTOUCHED, TO THE MILLISECOND, and this is the assertion that cannot be made anywhere but
     * here. `datetime-local` cannot represent seconds, so a form that re-sent the field it had prefilled
     * would round a detection recorded at 09:14:37 down to 09:14 — silently moving the instant every
     * deadline in this module counts from, including the 72-hour one, on a correction that was only ever
     * about the severity. The form therefore sends `detectedAt` only when the value actually moved, which
     * an API-level spec cannot observe because it never goes through the control.
     */
    expect(record.detectedAt).toBe(detectedAt);
  });

  test('offers no correction once the record is finished', async ({ page, request }) => {
    /*
     * `updateIncident` calls `assertOpen`, so a finished record answers `INCIDENT_NOT_IN_STATE` — "add a
     * timeline entry instead". A Correct button on such a row would be a button whose only possible
     * outcome is that refusal, teaching the rule through an error rather than through the absence of the
     * action.
     *
     * DISMISSED RATHER THAN CLOSED, deliberately: `false_positive` is the terminal state that gets
     * forgotten, because it is reached by a different route and does not have "closed" in its name. The
     * closed half of the same rule is pinned in the API suite.
     */
    const incident = await reportIncident(request, unique('PWN').toUpperCase());
    const dismissed = await request.post(`/v1/incidents/${incident.id}/dismiss`, {
      headers: await csrfHeaders(request),
      data: { reason: 'A scheduled penetration test nobody had announced.' },
    });
    expect(dismissed.status(), await dismissed.text()).toBe(200);

    await gotoInShell(page, '/incidents');
    await page
      .getByRole('radiogroup', { name: /status/i })
      .getByRole('radio', { name: 'False positive' })
      .click();
    await expectRowSomewhere(page, incident.reference);

    const row = page.locator('tbody tr', { hasText: incident.reference });
    await expect(row).toContainText('False positive');
    await expect(row.getByRole('button', { name: 'Correct' })).toHaveCount(0);
  });

  test('dismissing needs a reason, and the report stays in the register', async ({
    page,
    request,
  }) => {
    const incident = await reportIncident(request, unique('PWF').toUpperCase());

    await gotoInShell(page, '/incidents');
    await expectRowSomewhere(page, incident.reference);
    await page
      .locator('tbody tr', { hasText: incident.reference })
      .getByRole('button', { name: 'Dismiss' })
      .click();

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText(/dismissing is not deleting/i)).toBeVisible();
    await expect(dialog.getByLabel(/why it was not an incident/i)).toHaveAttribute('required', '');
    await dialog
      .getByLabel(/why it was not an incident/i)
      .fill('Simulated phishing test run by the security team.');
    await dialog.getByRole('button', { name: /^Dismiss$/ }).click();
    await expect(dialog).toBeHidden();

    // Still there, as a false positive — the register keeps what was reported.
    await page
      .getByRole('radiogroup', { name: /status/i })
      .getByRole('radio', { name: 'False positive' })
      .click();
    await expectRowSomewhere(page, incident.reference);
    await expect(page.locator('tbody tr', { hasText: incident.reference })).toContainText(
      'False positive',
    );
  });
});
