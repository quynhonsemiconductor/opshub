// @vitest-environment jsdom
/**
 * WHO CAN SEE WHAT IN THE NAV — a product decision, asserted rather than assumed.
 *
 * WHY THIS FILE EXISTS. `/access` was gated on `access_request.read`, and `ROLE.EMPLOYEE` holds no
 * permissions at all — deliberately, because the permission catalogue says self-service access "is
 * expressed by the `self` SCOPE on a grant, not by a permission code". Meanwhile every route behind
 * that page would have served them: `POST /access-requests` is `@SelfScoped`, the list narrows to the
 * caller when they lack the read code, and `grants/me/active` is `@SelfScoped`. So the nav hid the
 * flagship self-service journey from most of the organisation, and nobody noticed because all eight
 * browser-test seats are admins and see every entry.
 *
 * That is the gap this closes: a permission-less caller is a tier no browser test represents.
 */
import { describe, expect, it } from 'vitest';

import { navGroups } from './nav-groups';

/** The entries a caller with the given permissions would see, flattened across groups. */
function visibleTo(permissions: string[]): string[] {
  const can = (cap: string) => permissions.includes('*') || permissions.includes(cap);
  return navGroups.flatMap((group) =>
    group.items.filter((item) => !item.cap || can(item.cap)).map((item) => item.to),
  );
}

describe('the nav, for an employee who holds nothing', () => {
  it('offers the self-service pages', () => {
    const visible = visibleTo([]);

    /*
     * These three are the whole of what an employee does with the nav: see their overview, raise and
     * track a request, and ask for access or see what access they hold. Every one is served by a
     * self-scoped or self-narrowing route. Their profile is reached from the footer, not from here.
     */
    expect(visible, 'the Overview is gated').toContain('/');
    expect(visible, 'the Inbox is gated').toContain('/requests');
    expect(
      visible,
      'Access Requests is gated on a permission the employee role deliberately does not hold',
    ).toContain('/access');
    /*
     * NOT `/profile`. It is reached from the footer identity button rather than a nav group, which I
     * asserted wrongly at first — the test was wrong, not the shell. Left here as the note, because
     * "the employee's pages" is otherwise an easy list to get wrong in the other direction too.
     */
    expect(visible, '/profile is a footer link, not a nav entry').not.toContain('/profile');
  });

  it('does not offer the administrative pages', () => {
    /*
     * The other half, and the reason this is not simply "ungate everything": a page whose every route
     * needs a permission is noise in the nav and a wall of 403s when opened. Asserted so that
     * loosening one gate cannot quietly loosen the rest.
     */
    const visible = visibleTo([]);

    expect(visible).not.toContain('/people');
    expect(visible).not.toContain('/assets');
    expect(visible).not.toContain('/settings/access-control');
    expect(visible).not.toContain('/risks');
  });
});

describe('a page gated on the wrong resource', () => {
  it('gates FinOps on a licence permission, not a compliance one', () => {
    /*
     * Every route behind /finops requires `license.read` or `license.manage`. It was gated on
     * `compliance.read` — latent for the eight seeded roles, which happen to hold both or neither,
     * and wrong for exactly the finance-shaped role the licence service's own docblock describes:
     * granted the licence bundle, and shown no link to the page it is for.
     */
    expect(visibleTo(['license.read'])).toContain('/finops');
    expect(visibleTo(['compliance.read'])).not.toContain('/finops');
  });
});

describe('an admin', () => {
  it('sees every entry, so the gates above are not hiding a typo', () => {
    /*
     * THE FLOOR. Every assertion above is about something being absent, and a mis-spelled `to` or a
     * dropped group would satisfy all of them. The wildcard holder must see the lot.
     */
    const visible = visibleTo(['*']);
    const total = navGroups.reduce((sum, group) => sum + group.items.length, 0);

    expect(visible).toHaveLength(total);
    expect(total, 'the nav lost its entries').toBeGreaterThan(20);
  });
});
