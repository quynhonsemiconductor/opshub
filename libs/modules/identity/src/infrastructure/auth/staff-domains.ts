/**
 * Email domain(s) of the company: the `staff` preset refuses a Microsoft sign-in whose address is outside them,
 * and password sign-up for them (there is none here). Decided with the owner: `qnsc.vn`.
 *
 * Its own file because two places need it and one must not import the other: the identity factory passes it to
 * `createIdentity`, and the sign-in hook checks it again as its own, independent line of defence.
 */
export const STAFF_EMAIL_DOMAINS: readonly string[] = ['qnsc.vn'];

/**
 * Whether an address is on a staff domain: EXACTLY the domain (case-insensitive), not a subdomain and not a
 * look-alike (`qnsc.vn.evil.example`, `evilqnsc.vn`). Anything without a single `@` is not an address.
 */
export function isStaffEmail(email: string): boolean {
  const parts = email.trim().toLowerCase().split('@');
  if (parts.length !== 2 || parts[0] === '') return false;
  return STAFF_EMAIL_DOMAINS.includes(parts[1] ?? '');
}
