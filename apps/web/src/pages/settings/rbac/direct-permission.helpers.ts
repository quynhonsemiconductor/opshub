import { DIRECT_PERMISSION_REASON_MIN_LENGTH } from './direct-permission.constants';

/** What the grant form collects, before it is sent. */
export interface GrantFormValues {
  employeeId: string;
  permissionKey: string;
  reason: string;
}

/**
 * Checks the grant form before it is sent, so the common mistakes are named next to the field.
 *
 * Args:
 *   values: The employee, the permission and the reason as typed.
 *
 * Returns:
 *   A sentence naming what is missing, or null when the form can be submitted. The API still decides
 *   (it refuses a permission the caller does not hold); this only saves a round trip for an empty field.
 */
export function validateGrantForm(values: GrantFormValues): string | null {
  if (!values.employeeId) return 'Choose an employee.';
  if (!values.permissionKey) return 'Choose a permission.';
  if (values.reason.trim().length < DIRECT_PERMISSION_REASON_MIN_LENGTH) {
    return 'Say why this employee needs the permission outside a group.';
  }
  return null;
}

/**
 * Turns the expiry date the form collects into the instant the API expects.
 *
 * The permission lasts through the chosen day, so the instant is the last second of that day in the
 * reader's timezone; midnight would end it a day early for anyone west of Greenwich.
 *
 * Args:
 *   date: A `YYYY-MM-DD` from a date input, or an empty string for "never expires".
 *
 * Returns:
 *   An ISO instant, or undefined when no date was chosen or the date is not a real one.
 */
export function expiryInstantFromDate(date: string): string | undefined {
  if (!date) return undefined;
  const endOfDay = new Date(`${date}T23:59:59`);
  return Number.isNaN(endOfDay.getTime()) ? undefined : endOfDay.toISOString();
}

/**
 * Tells whether a grant has already run out.
 *
 * Args:
 *   expiresAt: The grant's expiry as an ISO instant, or null for a grant that never expires.
 *   now: The moment to judge against; injected so the answer is testable.
 *
 * Returns:
 *   True when the grant has an expiry that is not after `now`.
 */
export function isGrantExpired(expiresAt: string | null, now: Date): boolean {
  return expiresAt !== null && new Date(expiresAt).getTime() <= now.getTime();
}
