/** Permissions the request engine consults itself; both only widen who may decide an assigned request. */

/** Who may decide a request whose assignee is unavailable: hr + admin only (managers lack it). */
export const ASSIGNEE_FALLBACK_PERMISSION = 'workforce.manage';

/**
 * Who may decide a request assigned to somebody who is still available.
 *
 * Not type-specific, so the `approver` group holds it once. The decider still needs the type's own
 * permission, and the decision is tagged on the approval row.
 */
export const ASSIGNEE_OVERRIDE_PERMISSION = 'request.decide_any';
