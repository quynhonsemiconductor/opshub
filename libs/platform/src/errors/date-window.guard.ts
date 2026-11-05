import type { ErrorCode } from './error-codes';
import { PreconditionFailedException } from './exceptions';

/**
 * Refuse a date range that runs backwards, with the module's own error code.
 *
 * WHY THIS IS SHARED RATHER THAN A PRIVATE METHOD PER MODULE
 * ---------------------------------------------------------
 * Several tables carry a `[from, to]` window guarded by a CHECK — `ck_employee_role_window`,
 * `ck_contract_window`, `ck_contract_probation_window`, `ck_contract_terminated_window` — and a bare
 * CHECK violation reaches the caller as a **500 with no error code**. So every one of them needs the
 * same refusal in front of it, and the roles module had already grown a private copy before
 * contracts needed a second. One implementation, a code per caller.
 *
 * DATES ARE ISO `YYYY-MM-DD` STRINGS and compared as strings, deliberately. In that format
 * lexicographic order IS chronological order, so there is no parsing, no `Date` object, and no
 * timezone to get wrong — a `new Date('2026-03-01')` comparison in a UTC+7 process is exactly how
 * off-by-one-day bugs get in.
 *
 * INCLUSIVE: `to === from` passes. A zero-length window is a correction recorded on the day it
 * started, which every CHECK here allows (`>=`), and the guard has to agree with the constraint it
 * stands in front of or it would refuse rows the database would accept.
 */
export function assertDateOrder(from: string, to: string, code: ErrorCode, what: string): void {
  if (to < from) {
    throw new PreconditionFailedException(code, `${what}: ${to} is before ${from}`);
  }
}
