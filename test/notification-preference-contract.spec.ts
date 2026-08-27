/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NOTIFICATION_TEMPLATE_NAMES } from '../libs/platform/src/notifications/notification.templates';

/**
 * The settings screen offers a toggle for exactly the notifications that can be sent.
 *
 * WHAT WENT WRONG WITHOUT THIS. The preferences page wrote its own list of event types by hand, and it
 * drifted in both directions at once:
 *
 *   - 13 of its 19 toggles named an event with NO TEMPLATE — `workforce.leave_requested`,
 *     `asset.retired`, `compliance.finding_resolved` and ten more. A notification needs a template to
 *     be rendered, so those could never fire however they were set. Worse, `PUT /preferences/:type`
 *     took the type as a bare string and stored the row, so the screen read back exactly as though the
 *     choice had been saved. It had been. It just could not matter.
 *
 *   - 9 templates that DO fire had no toggle at all, including `contract.expiring_soon`, `review.due`
 *     and `request.step_ready`. So the notifications people actually received were precisely the ones
 *     they had no way to turn off, and the ones they could turn off never arrived.
 *
 * BOTH DIRECTIONS ARE ASSERTED, and the second is the one that matters more. A screen offering a
 * control that does nothing is a lie a user can eventually notice; a notification with no control is
 * one they cannot escape. This is the asymmetry the permission contract deliberately does NOT assert —
 * there, plenty of backend codes legitimately have no UI. Here a template without a toggle is a defect
 * by definition, because rendering it means sending it to somebody.
 *
 * It lives in the BACKEND suite on purpose, like `fe-permission-contract.spec.ts`: the catalogue is in
 * `libs/`, and this way the check cannot be skipped by running only one project's tests.
 */

const ROOT = join(__dirname, '..');
const PAGE = 'apps/web/src/pages/notifications/notification-preferences-page.tsx';

/**
 * The event types the page offers a toggle for.
 *
 * Read out of the SOURCE rather than by rendering the page, because what is being checked is the
 * catalogue itself, not the markup — a render test would also need the API, the query client and a
 * session, and would fail for reasons that have nothing to do with the two lists agreeing.
 *
 * The `hint` field is deliberately not matched: it is prose and may contain anything.
 */
function toggledTypes(): string[] {
  const source = readFileSync(join(ROOT, PAGE), 'utf8');
  return [...source.matchAll(/\btype: '([a-z_]+(?:\.[a-z_]+)+)'/g)].map((m) => m[1]);
}

describe('notification preference contract', () => {
  it('offers no toggle for an event that cannot be sent', () => {
    const templates = new Set<string>(NOTIFICATION_TEMPLATE_NAMES);
    const impossible = toggledTypes().filter((t) => !templates.has(t));

    expect(
      impossible,
      'These event types have a toggle but no template, so they can never fire however the user ' +
        'sets them — and the API will still store the preference, which is what makes it convincing:\n' +
        impossible.join('\n'),
    ).toEqual([]);
  });

  it('leaves no sendable notification without a toggle', () => {
    const toggled = new Set(toggledTypes());
    const unmutable = NOTIFICATION_TEMPLATE_NAMES.filter((t) => !toggled.has(t));

    expect(
      unmutable,
      'These notifications can be sent but have no toggle, so a user cannot turn them off:\n' +
        unmutable.join('\n'),
    ).toEqual([]);
  });

  it('accepts the wildcard, which is not a template', () => {
    // `*` is the global mute. It is intentionally absent from the template list, so the assertions
    // above must not be written in a way that demands it be there.
    expect(new Set<string>(NOTIFICATION_TEMPLATE_NAMES).has('*')).toBe(false);
  });

  it('finds toggles at all, so a broken scanner fails loudly', () => {
    // The floor. Without it, a regex that stops matching turns both checks above into permanent
    // passes over an empty list — the classic way a contract test dies without anyone noticing.
    expect(toggledTypes().length).toBeGreaterThanOrEqual(NOTIFICATION_TEMPLATE_NAMES.length);
  });

  it('names every template exactly once', () => {
    // A duplicated entry would render two rows writing the same preference row, and would also mask a
    // missing one from the count check above.
    const seen = toggledTypes();
    expect(new Set(seen).size).toBe(seen.length);
  });
});
