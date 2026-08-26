import type { LeaveResponse, OvertimeResponse, TimesheetResponse } from '@/shared/api/types';

/**
 * The workforce approval rules these tabs have to agree with, mirrored from the API that enforces them.
 *
 * WHY THIS FILE EXISTS. The four tabs offered Approve, Reject, Cancel and Submit on the row's STATUS
 * alone — about thirty call sites and not one permission check between them, so `usePermissions` did not
 * appear in any of the four files. An employee holding nothing therefore saw Approve and Reject on every
 * leave, overtime and timesheet row in their own list, and every click came back a permanent 403 dressed
 * up as "please try again". Worse, everybody — including a manager who really can decide — was offered
 * those buttons on their OWN records, which separation of duties refuses by design
 * (`REQUEST_SOD_VIOLATION`), so the one decision guaranteed to fail was the one most likely to be
 * clicked.
 *
 * WHY IT IS A MODULE AND NOT INLINE JSX. Each rule is read twice on its tab — once in the row-actions
 * cell, once in the detail drawer's header — and a rule written twice inside a `cell` callback is a rule
 * that can disagree with itself. These are also claims ABOUT THE SERVER: they are wrong the moment the
 * controller or a type-def changes, and a claim buried in a ternary cannot be tested without rendering a
 * page. Same reasoning, and the same shape, as `pages/requests/request-policy.ts`.
 *
 * NOTHING HERE IS A SECURITY BOUNDARY. `PolicyGuard`, `WorkforceService` and `RequestEngineService`
 * enforce all of it. This only decides whether to offer an action that would otherwise come back as a
 * 403 or a 412 the user can do nothing about.
 */

/** Reads a permission key exactly as `usePermissions().can` does, wildcard included. */
export type Can = (permission: string) => boolean;

/**
 * Deciding leave needs BOTH codes, and a holder of one and not the other is the case that made this
 * worth spelling out.
 *
 * `POST /leave/:id/review` carries `@RequirePermission('workforce.approve')`, so that is what the route
 * guard checks. But the route hands the decision to the request engine, and
 * `LeaveRequestTypeDef.requiredApprovalPermission` is `'workforce.leave.review'`, which
 * `RequestEngineService.approve` checks separately. So somebody holding `workforce.approve` alone gets
 * past the guard and is refused inside the transaction — a 403 arriving from a route they were allowed
 * to call. Both are read here because the API reads both.
 *
 * The seeded `hr` and `manager` roles hold the pair, so no seat in the browser suite can tell these two
 * codes apart; a hand-built role granting one of them can.
 */
export const LEAVE_REVIEW_PERMISSIONS = ['workforce.approve', 'workforce.leave.review'] as const;

/** The same pair for overtime, from `OvertimeTypeDef.requiredApprovalPermission`. */
export const OVERTIME_REVIEW_PERMISSIONS = [
  'workforce.approve',
  'workforce.overtime.review',
] as const;

/**
 * Timesheets need `workforce.approve` and nothing else.
 *
 * `POST /timesheets/:id/review` requires it, and `WorkforceService.reviewTimesheet` writes the status
 * directly rather than going through the request engine — there is no timesheet `RequestTypeDef`, so
 * there is no second permission and no engine-side check. Listing it as a one-element array rather than
 * a bare string keeps the three review rules the same shape, so a reader comparing them sees the
 * difference is the permission and not the mechanism.
 */
export const TIMESHEET_REVIEW_PERMISSIONS = ['workforce.approve'] as const;

/** `workforce.approve`, unconstrained, is what `assertOwnerOrApprover` accepts from a non-owner. */
export const OWNER_OR_APPROVER_PERMISSION = 'workforce.approve';

/**
 * Why a decision is or is not on offer.
 *
 * Four of the five outcomes are "no", and they are kept apart because they lead the reader somewhere
 * different: a decided record has nothing left to do, a colleague's record needs a permission they can
 * ask for, and their own record needs a different person. Collapsing them into a boolean would render
 * the same blank cell for all four.
 */
export type DecisionVerdict =
  /** Offer it — the record is awaiting a decision this viewer is allowed to make. */
  | 'offer'
  /** Already decided, withdrawn or expired: the API answers any review with a 412. */
  | 'not_pending'
  /** `/me` has not resolved, so ownership is not yet knowable. Say nothing rather than guess. */
  | 'unknown_viewer'
  /** The viewer lacks a code the route guard or the engine requires. */
  | 'not_permitted'
  /** The viewer raised it. Separation of duties refuses their own approval. */
  | 'own_record';

/**
 * WHEN THE ANSWER IS NO, SAY WHY rather than rendering an empty cell — the same two lines the requests
 * inbox uses, deliberately word for word, because it is the same fact about the same request and a
 * second phrasing would read as a second rule. "Ask a colleague" and "ask for access" are different
 * next actions, and a blank cell suggests neither.
 *
 * `not_pending` and `unknown_viewer` have no entry on purpose: there is nothing to explain about a
 * decided record, and a sentence that appears for a third of a second while `/me` lands is noise.
 */
const DECISION_NOTE: Partial<Record<DecisionVerdict, string>> = {
  own_record: 'Yours — a colleague decides',
  not_permitted: 'Not yours to decide',
};

/** The line to show in place of the buttons, or null when the right answer is to show nothing. */
export function decisionNote(verdict: DecisionVerdict): string | null {
  return DECISION_NOTE[verdict] ?? null;
}

/**
 * The one rule the three review verdicts share, ordered the way the screen has to read.
 *
 * THE ORDER IS THE ENGINE'S OWN, not a convenience: `RequestEngineService.viewerMayDecide` tests status,
 * then separation of duties, then the permission, and it says why in a comment — "ask a colleague" is
 * different advice from "ask for access". Reversing the last two would tell an employee holding nothing
 * "Not yours to decide" about a request they raised themselves, which is both wrong and useless.
 *
 * STATUS FIRST, because a decided record is finished and none of the caller's properties matter to it —
 * an admin looking at last month's approved leave should see no controls and no explanation.
 *
 * IDENTITY BEFORE EITHER, because `can` and the viewer's `sub` come from the same `/me` query: while it
 * is in flight `can` answers false for everything, so any verdict computed then is a guess. Undefined
 * `meSub` means "not yet known", and the only honest thing to render for that is nothing.
 */
function reviewVerdict(
  record: { status: string; employeeId: string },
  pendingStatus: string,
  meSub: string | undefined,
  can: Can,
  required: readonly string[],
): DecisionVerdict {
  if (record.status !== pendingStatus) return 'not_pending';
  if (!meSub) return 'unknown_viewer';
  // `RequestEngineService` compares the request's `requesterId` against the acting subject, and
  // `createLeave`/`createOvertime` set `employeeId` to `actor.sub`, so the row's owner IS the requester
  // the engine will refuse. Comparing ids here asks the engine's question with the engine's operands.
  if (record.employeeId === meSub) return 'own_record';
  if (!required.every((permission) => can(permission))) return 'not_permitted';
  return 'offer';
}

/** Whether to offer Approve/Reject on a leave request — `POST /leave/:id/review`. */
export function leaveReviewVerdict(
  leave: Pick<LeaveResponse, 'status' | 'employeeId'>,
  meSub: string | undefined,
  can: Can,
): DecisionVerdict {
  // `'Only pending leave requests can be reviewed'` — `LEAVE_REQUEST_NOT_PENDING`.
  return reviewVerdict(leave, 'pending', meSub, can, LEAVE_REVIEW_PERMISSIONS);
}

/** Whether to offer Approve/Reject on an overtime entry — `POST /overtime/:id/review`. */
export function overtimeReviewVerdict(
  entry: Pick<OvertimeResponse, 'status' | 'employeeId'>,
  meSub: string | undefined,
  can: Can,
): DecisionVerdict {
  return reviewVerdict(entry, 'pending', meSub, can, OVERTIME_REVIEW_PERMISSIONS);
}

/**
 * Whether to offer Approve/Reject on a timesheet — `POST /timesheets/:id/review`.
 *
 * WITHHELD ON THE VIEWER'S OWN TIMESHEET, and this one is worth a note because the reason changed.
 *
 * Timesheets do not go through the request engine — `reviewTimesheet` writes the status directly — so they
 * inherited none of the `allowSelfApproval: false` that refuses self-approval on leave, overtime, access
 * and onboarding. For a while nothing stopped a `workforce.approve` holder from approving their own hours,
 * the record payroll is computed from, and this predicate was the ONLY thing withholding it.
 *
 * `WorkforceService.reviewTimesheet` now refuses it by `REQUEST_SOD_VIOLATION`, so this is a mirror of the
 * API again rather than stricter than it. It still matters: the API refusing an act is not a reason to
 * offer a button that will fail, and `test/e2e/timesheet-self-approval.e2e.spec.ts` is what holds the
 * server half — not this file, which a caller with `curl` never runs.
 */
export function timesheetReviewVerdict(
  timesheet: Pick<TimesheetResponse, 'status' | 'employeeId'>,
  meSub: string | undefined,
  can: Can,
): DecisionVerdict {
  // `'Only submitted timesheets can be reviewed'` — `TIMESHEET_NOT_EDITABLE`.
  return reviewVerdict(timesheet, 'submitted', meSub, can, TIMESHEET_REVIEW_PERMISSIONS);
}

/**
 * Whether to offer WITHDRAWING a leave request — the mirror image of reviewing it.
 *
 * `cancelLeave` calls `assertOwnerOrApprover`: the owner passes on identity alone, and anybody else needs
 * `workforce.approve` unconstrained. So this is the one control an employee holding no permissions at all
 * SHOULD see on their own row, and gating it on a permission would have broken the only leave transition
 * they can make themselves.
 *
 * Note the asymmetry with `leaveReviewVerdict`: owning the record is what QUALIFIES you here and what
 * disqualifies you there. Withdrawing is the requester taking back the asking; the person deciding has
 * Reject instead.
 */
export function canCancelLeave(
  leave: Pick<LeaveResponse, 'status' | 'employeeId'>,
  meSub: string | undefined,
  can: Can,
): boolean {
  // Kept to `pending` as the tab has always had it, though `cancelLeave` also accepts `approved`:
  // withdrawing leave that was already granted is a capability this screen has never offered and adding
  // it is a change to what the product does, not to who may do it.
  if (leave.status !== 'pending') return false;
  return (!!meSub && leave.employeeId === meSub) || can(OWNER_OR_APPROVER_PERMISSION);
}

/**
 * Whether to offer SUBMITTING a timesheet for approval — `POST /timesheets/:id/submit`.
 *
 * The same `assertOwnerOrApprover` rule as withdrawing leave, and for the same reason: submitting your own
 * hours is self-service and needs no permission, while pushing somebody else's draft through is an HR
 * administrator acting on their behalf and needs `workforce.approve`.
 */
export function canSubmitTimesheet(
  timesheet: Pick<TimesheetResponse, 'status' | 'employeeId'>,
  meSub: string | undefined,
  can: Can,
): boolean {
  // `submitTimesheet` also accepts `rejected` — a rejected sheet is meant to be corrected and resubmitted
  // — but this tab has only ever offered Submit on a draft, so re-submission stays a separate change.
  if (timesheet.status !== 'draft') return false;
  return (!!meSub && timesheet.employeeId === meSub) || can(OWNER_OR_APPROVER_PERMISSION);
}
