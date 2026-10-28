/**
 * Shared application constants.
 *
 * Use these instead of inline magic strings/numbers.  Values must match the DB
 * enums and the RequestEngine type discriminators exactly — only change both
 * together.
 */

// ── Report ceilings ──────────────────────────────────────────────────────────

/**
 * How many rows a management report returns when nobody asked for a number.
 *
 * WHY A CONSTANT AND NOT A LITERAL. Ten report methods each carried their own `limit = 200`, and none of
 * their HTTP callers pass one — so those literals were not defaults, they were the CAP on what the screen
 * and the §9.3 agenda can ever see, spelled out ten times. Changing what a report will show meant finding
 * all ten and hoping.
 *
 * WHY 200 AND NOT UNBOUNDED. A report is read to decide something. Two hundred overdue rows is already a
 * finding about the process rather than a list to work through, and every one of these reports feeds an
 * agenda item that samples the first handful anyway.
 *
 * Reports that deliberately return FEWER say so at the call site with their own reason.
 */
export const REPORT_ROW_LIMIT = 200;

// ── Request engine type discriminators ───────────────────────────────────────

export const REQUEST_TYPE = {
  ACCESS_REQUEST: 'access_request',
  ONBOARDING: 'onboarding',
  OFFBOARDING: 'offboarding',
  LEAVE_REQUEST: 'leave_request',
  /**
   * Work from home, as a manager-approved request. The rules (2026-10-28) make every non-office day
   * a request on the engine: leave, WFH, or an attendance justification — so WFH is not a self-tick.
   */
  WFH_REQUEST: 'wfh_request',
  OVERTIME: 'overtime',
  CATALOG_REQUEST: 'catalog_request',
  DOCUMENT_APPROVAL: 'document_approval',
  /**
   * Sign-off for ACCEPTING a residual risk rather than treating it.
   *
   * Accepting risk is the one ISMS decision that creates exposure by choice, so ISO 27001 asks for
   * a named accountable approver. That is an approval, so it is the engine's — not a second status
   * column with its own approver check.
   */
  RISK_ACCEPTANCE: 'risk_acceptance',
  /**
   * Calibration sign-off on a performance rating, before the employee sees it.
   *
   * An approval, so it belongs to the engine rather than to a second approver column on the review:
   * separation of duties, the SLA clock, expiry, the audit entry and the notification all come with
   * it. The reviewer submits; somebody holding `performance.approve` who is neither the reviewer nor
   * the employee decides.
   */
  PERFORMANCE_REVIEW: 'performance_review',
} as const;

export type RequestType = (typeof REQUEST_TYPE)[keyof typeof REQUEST_TYPE];

// ── RBAC roles + permissions ──────────────────────────────────────────────────
//
// Deliberately NOT here. Role keys and permission codes are defined once in
// db/permissions.catalog.ts and re-exported by ./permissions.ts, because the seed
// (which only ships db/**) and the guards must read the same list.
//
// This file previously declared its own PERMISSION map with a DIFFERENT
// vocabulary — `assets.view`/`licenses.view`/`audit.view` against the database's
// `asset.read`/`license.read`/`audit.read`. Nothing imported it, so it never broke
// anything; it was one autocomplete away from gating a route on a permission no
// role can hold.

// ── Access request types ──────────────────────────────────────────────────────

export const ACCESS_TYPE = {
  LOCAL_ADMIN: 'local_admin',
  PIM_ROLE: 'pim_role',
  APP_ADMIN: 'app_admin',
  VPN: 'vpn',
  OTHER: 'other',
} as const;

export type AccessType = (typeof ACCESS_TYPE)[keyof typeof ACCESS_TYPE];

// ── Pagination ────────────────────────────────────────────────────────────────

export const PAGE_SIZE = {
  DEFAULT: 50,
  MAX: 100,
  NOTIFICATION_DEFAULT: 20,
  AUDIT_MAX: 500,
} as const;

// ── Audit action strings ──────────────────────────────────────────────────────
//
// Deliberately NOT here either — and for exactly the reason described just above
// about PERMISSION, which is the same mistake this file made twice.
//
// A 40-key `AUDIT_ACTION` used to live here alongside the real 181-key catalogue in
// `@modules/audit` (`domain/audit-catalogue.ts`). Nothing imported this one; every
// service reaches for `@modules/audit`. But `shared-kernel` is re-exported
// wholesale, so `import { AUDIT_ACTION } from '@shared-kernel'` silently resolved to
// the smaller, staler set — one autocomplete away, again.
//
// It was not merely redundant. Four keys carried DIFFERENT VALUES for the same event
// (`catalog.item_created` here against `catalog_item.created` there), and the seven
// `RBAC_*` keys duplicated `role.*` and `delegation.*` under another name. Writing
// one and querying the other loses rows from the trail, and nothing fails.
//
// `test/audit-catalogue-single-source.spec.ts` keeps a third copy from appearing.
