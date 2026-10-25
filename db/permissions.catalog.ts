/**
 * Canonical permission catalogue — the SINGLE source of truth for authorization.
 *
 * This file lives in `db/` (not `libs/`) on purpose: it is the one place both the
 * standalone migrator/seed image (which bundles `db/**` only) and the NestJS app
 * (via `@shared-kernel`, which re-exports it) can import. Keeping it here is what
 * stops the seed's role definitions, the backend's `@RequirePermission`
 * decorators, and the frontend's `can()` gating from drifting apart.
 *
 * Why it exists: before this, opshub had TWO permission vocabularies. `db/seed.ts`
 * defined `asset.read` / `license.read` / `audit.read` and inserted them into the
 * database, while `libs/shared-kernel/src/constants.ts` declared a `PERMISSION`
 * const holding `assets.view` / `licenses.view` / `audit.view` — codes that were
 * never seeded and that nobody could hold. Nothing referenced the constant, so it
 * was harmless in practice and loaded in principle: one autocomplete of
 * `PERMISSION.ASSETS_VIEW` would have gated a route on a permission no role
 * grants, and the route would have failed closed for everyone but `*`.
 *
 * ⚠️  Dependency-free by design — do NOT import from `libs/` here, or the
 *     migrator Docker image (which copies `db/**` only) fails to build.
 */

// ── Permission codes ─────────────────────────────────────────────────────────
//
// Convention: `<module>.<action>`, where `<module>` is the business area. The
// module is DERIVED from the code (see `moduleOf`) rather than tracked
// separately, so a new module is one line here and nothing else.
//
// Naming is `read`/`write`/`manage` + explicit verbs for state transitions
// (`approve`, `provision`, `reassign`). Keep the vocabulary boring: a reader
// should be able to guess the code for an action they have not seen yet.

export const PERMISSION = {
  // ── meta / rbac ────────────────────────────────────────────────────────────
  RBAC_READ: 'rbac.read',
  RBAC_MANAGE: 'rbac.manage',
  ROLE_ASSIGN: 'role.assign',

  // ── identity / people ──────────────────────────────────────────────────────
  EMPLOYEE_READ: 'employee.read',
  EMPLOYEE_WRITE: 'employee.write',
  EMPLOYEE_OFFBOARD: 'employee.offboard',
  /** View the position catalogue, approved headcount and occupancy. */
  POSITION_READ: 'position.read',
  /**
   * Define positions and assign people to them.
   *
   * Separate from `employee.write`: changing someone's contact details is an HR-admin act, while
   * approving a headcount or moving somebody between roles changes the org structure.
   */
  POSITION_MANAGE: 'position.manage',
  /** View employment contracts: terms, dates, notice, status — but NOT the money. */
  CONTRACT_READ: 'contract.read',
  /** Draft, activate, renew and terminate employment contracts. */
  CONTRACT_MANAGE: 'contract.manage',
  /**
   * See the pay figures on a contract.
   *
   * Separate from `contract.read` because who may know an engagement exists and who may know what
   * it pays are different questions — an auditor checking that every employee HAS a signed contract
   * needs the first and not the second. Employees always see their OWN figures regardless: their
   * pay is theirs, and that is a scope rule, not a permission.
   */
  CONTRACT_COMPENSATION_READ: 'contract.compensation.read',
  /** View the course catalogue, position requirements, records and the competency gap report. */
  TRAINING_READ: 'training.read',
  /**
   * Manage the catalogue and requirements, and VERIFY or revoke a record.
   *
   * Recording your OWN completion needs no permission — that is self-service, gated by scope. What
   * needs one is attesting that somebody else's evidence is genuine, which is the control an ISO
   * competency audit actually looks for.
   */
  TRAINING_MANAGE: 'training.manage',

  // ── EMS performance reviews ────────────────────────────────────────────────
  /** View review cycles, other people's reviews, and the coverage report. */
  PERFORMANCE_READ: 'performance.read',
  /**
   * Run the process: open and close cycles, create reviews, assign reviewers, set goals.
   *
   * Writing your OWN self-assessment and acknowledging your OWN review need no permission — those
   * are self-service, gated by scope, exactly as recording your own training completion is. What
   * needs a permission is deciding that somebody will be reviewed, and by whom.
   */
  PERFORMANCE_MANAGE: 'performance.manage',
  /**
   * Sign off a rating before the employee sees it — the calibration step.
   *
   * Deliberately separate from `performance.manage`: the value of calibration is that a second
   * person looks at the rating, and a manager who could both rate and approve would make the step
   * a formality. The request engine keeps the submitter out of their own chain; the type def also
   * refuses the EMPLOYEE, who would otherwise be able to approve their own review with this code.
   */
  PERFORMANCE_APPROVE: 'performance.approve',

  // ── ISMS risk ──────────────────────────────────────────────────────────────
  /** View the risk register, treatment plans and the review-due report. */
  RISK_READ: 'risk.read',
  /** Identify, score, treat and close risks. */
  RISK_MANAGE: 'risk.manage',
  /**
   * Approve ACCEPTING a residual risk rather than treating it.
   *
   * Deliberately separate from `risk.manage`: accepting risk is the one ISMS decision that creates
   * exposure by choice, and the person who assessed it should not be the person who signs it off.
   * The request engine enforces that separation; this code decides who may be in the chain at all.
   */
  RISK_ACCEPT: 'risk.accept',
  /** View the control catalogue, the Statement of Applicability and the coverage report. */
  CONTROL_READ: 'control.read',
  /**
   * Maintain the catalogue and the SoA: applicability, justification, implementation status.
   *
   * Separate from `risk.manage` because the SoA is the document an ISO 27001 audit is conducted
   * against — deciding a control is out of scope is a scope decision, not a risk assessment.
   */
  CONTROL_MANAGE: 'control.manage',
  /** View the incident register and its timelines. */
  INCIDENT_READ: 'incident.read',
  /**
   * Report, triage, contain, resolve and close incidents; record timeline entries.
   *
   * Reporting one needs no permission — anybody who notices something must be able to raise it, and
   * `POST /incidents/report` is self-service for exactly that reason. This code governs HANDLING.
   */
  INCIDENT_MANAGE: 'incident.manage',

  // ── ISMS information assets ────────────────────────────────────────────────
  /** View the information asset register, its classification history and the device holdings. */
  INFORMATION_ASSET_READ: 'information_asset.read',
  /**
   * Register assets, re-rate them, RAISE a classification, link the devices that hold them.
   *
   * Deliberately not `asset.write`, which is the DEVICE inventory held by IT and the service desk.
   * Deciding that a system holds restricted personal data is an ISMS judgement about information,
   * not a hardware record, and the two should not travel together.
   */
  INFORMATION_ASSET_MANAGE: 'information_asset.manage',
  /**
   * LOWER a classification.
   *
   * Separate from `information_asset.manage` for the same reason `risk.accept` is separate from
   * `risk.manage`: this is the one change to the register that makes information easier to reach, and
   * the person who wants it declassified should not be the only person who agrees. Raising protection
   * is ordinary maintenance and stays with `manage`; reducing it needs this.
   *
   * Like `risk.accept`, it is in NO default role bundle — it is granted deliberately or not at all.
   */
  INFORMATION_ASSET_DECLASSIFY: 'information_asset.declassify',

  // ── ISMS vendor risk ───────────────────────────────────────────────────────
  /** View the supplier register, its assessments and the vendor-risk reports. */
  VENDOR_READ: 'vendor.read',
  /** Register suppliers, record due-diligence assessments, suspend, terminate, link risks. */
  VENDOR_MANAGE: 'vendor.manage',
  /**
   * APPROVE a supplier for live use.
   *
   * The third permission in this codebase for an act that creates exposure by choice, after
   * `risk.accept` and `information_asset.declassify`, and separated for the same reason: the person
   * who ran the due diligence should not be the only person who decides the organisation may now
   * depend on it. Suspending and terminating stay with `manage` — stopping is never the risky
   * direction.
   *
   * In NO default role bundle.
   */
  VENDOR_APPROVE: 'vendor.approve',

  // ── QMS non-conformance and CAPA ───────────────────────────────────────────
  /**
   * View the non-conformance register, its corrective actions and the quality reports.
   *
   * There is deliberately no `capa.read`. A CAPA only ever exists against a finding, so anybody who
   * may read the finding may read what was done about it — a second code would be one more thing to
   * grant and would gate nothing that this one does not already.
   */
  NONCONFORMANCE_READ: 'nonconformance.read',
  /**
   * Grade, own, contain, close and void findings.
   *
   * RAISING one needs no permission: anybody who notices a process failure must be able to record
   * it, and `POST /nonconformances/report` is self-service for exactly that reason — the same
   * argument that keeps incident reporting open. This code governs HANDLING.
   */
  NONCONFORMANCE_MANAGE: 'nonconformance.manage',
  /** Open corrective actions, record the analysis, plan and implement them. */
  CAPA_MANAGE: 'capa.manage',
  /**
   * Sign off the EFFECTIVENESS REVIEW — ISO 9001 §10.2(d).
   *
   * The fourth permission in this codebase for an act that creates exposure by choice, after
   * `risk.accept`, `information_asset.declassify` and `vendor.approve`. Verifying a CAPA is what
   * unlocks closing a major finding, so the person who did the work should not be the person who
   * certifies it worked — the service also refuses a verifier who owns the CAPA, because a
   * permission says who MAY sign and not whether this signature means anything.
   *
   * In NO default role bundle.
   */
  CAPA_VERIFY: 'capa.verify',

  // ── QMS internal audit ─────────────────────────────────────────────────────
  /** View the audit programme, each engagement's roster, its findings and the reports. */
  INTERNAL_AUDIT_READ: 'internal_audit.read',
  /**
   * Plan audits, roster auditors, start, report, close and cancel them.
   *
   * There is deliberately no separate code for reporting. §9.2.2(d) makes reporting an obligation
   * rather than a privilege — the audit team reports what it found, and gating that behind a scarcer
   * permission is how results wait for somebody who is on holiday. What IS gated separately is the
   * effectiveness review of any corrective action arising (`capa.verify`), and the impartiality rule
   * in `CapaService` keeps the auditors themselves out of that.
   */
  INTERNAL_AUDIT_MANAGE: 'internal_audit.manage',

  // ── QMS management review ──────────────────────────────────────────────────
  /**
   * View the review programme, its minutes, its actions and the assembled §9.3.2 agenda.
   *
   * The agenda COMPOSES the other registers, so this code reveals how much is outstanding across the
   * ISMS and QMS and which items by reference — but not their owners, their suppliers' commercial
   * detail or any classification. §9.3.2 asks for trends and aggregate performance, and the narrowing
   * is what stops this becoming a way around the registers' own permissions.
   */
  MANAGEMENT_REVIEW_READ: 'management_review.read',
  /** Schedule, hold, close and cancel reviews, and raise and track the actions out of them. */
  MANAGEMENT_REVIEW_MANAGE: 'management_review.manage',

  // ── assets ─────────────────────────────────────────────────────────────────
  ASSET_READ: 'asset.read',
  ASSET_WRITE: 'asset.write',
  ASSET_REASSIGN: 'asset.reassign',

  // ── access requests ────────────────────────────────────────────────────────
  ACCESS_REQUEST_READ: 'access_request.read',
  /**
   * Read requests in the generic approval engine that you are not a party to.
   *
   * Without it, `GET /requests` narrows to the caller's own requests plus the ones assigned to
   * them, and a by-id read they are not a party to is refused. The `employee` tier holds no
   * codes at all, so self-service works entirely through that narrowing.
   */
  REQUEST_READ: 'request.read',
  ACCESS_REQUEST_APPROVE: 'access_request.approve',
  ACCESS_REQUEST_SECURITY_APPROVE: 'access_request.security_approve',

  // ── compliance ─────────────────────────────────────────────────────────────
  COMPLIANCE_READ: 'compliance.read',
  COMPLIANCE_MANAGE: 'compliance.manage',

  // ── workforce (timesheets, leave, overtime) ────────────────────────────────
  WORKFORCE_READ: 'workforce.read',
  /**
   * Administer the leave POLICY — the holiday calendar and annual entitlements.
   *
   * Distinct from `workforce.approve`, which decides individual requests. Setting someone's
   * allowance or declaring a public holiday changes what every future request costs, so it is a
   * different act with a different blast radius, and an approver should not automatically hold it.
   */
  WORKFORCE_MANAGE: 'workforce.manage',
  WORKFORCE_APPROVE: 'workforce.approve',
  WORKFORCE_LEAVE_REVIEW: 'workforce.leave.review',
  WORKFORCE_OVERTIME_REVIEW: 'workforce.overtime.review',

  // ── onboarding / offboarding workflows ─────────────────────────────────────
  ONBOARDING_APPROVE: 'onboarding.approve',
  ONBOARDING_PROVISION: 'onboarding.provision',
  ONBOARDING_COMPLETE: 'onboarding.complete',
  OFFBOARDING_APPROVE: 'offboarding.approve',

  // ── audit ──────────────────────────────────────────────────────────────────
  AUDIT_READ: 'audit.read',

  // ── reports ────────────────────────────────────────────────────────────────
  REPORTS_READ: 'reports.read',

  // ── security posture ───────────────────────────────────────────────────────
  SECURITY_VIEW: 'security.view',
  SECURITY_MANAGE: 'security.manage',

  // ── notifications ──────────────────────────────────────────────────────────
  NOTIFICATIONS_MANAGE: 'notifications.manage',

  // ── outbound webhooks ──────────────────────────────────────────────────────
  WEBHOOKS_MANAGE: 'webhooks.manage',

  // ── service catalog ────────────────────────────────────────────────────────
  CATALOG_MANAGE: 'catalog.manage',
  /**
   * Approve a request raised against a catalog item.
   *
   * Separate from `catalog.manage` because owning the catalogue and deciding an individual
   * request are different jobs, and the naming convention above reserves explicit verbs for
   * state transitions. `CatalogRequestTypeDef` previously named `requests.approve` — a code
   * that exists in no catalogue and no bundle, so every catalog request was unapprovable by
   * anybody but the `*` holder, silently, with a 403 naming a permission nobody could be
   * granted.
   */
  CATALOG_APPROVE: 'catalog.approve',
  /** Read the controlled-document library beyond what is published to everyone. */
  DOCUMENTS_READ: 'documents.read',
  /** Author documents and open new drafts. */
  DOCUMENTS_MANAGE: 'documents.manage',
  /** Approve a document version. Separate from publishing: approval says the content is correct. */
  DOCUMENTS_APPROVE: 'documents.approve',
  /**
   * Put an approved version into force.
   *
   * Distinct from `documents.approve` because a policy is routinely approved before the date it
   * takes effect, and because publishing supersedes whatever it replaces — a larger act than
   * agreeing the text is right.
   */
  DOCUMENTS_PUBLISH: 'documents.publish',

  // ── software licences ──────────────────────────────────────────────────────
  LICENSE_READ: 'license.read',
  LICENSE_MANAGE: 'license.manage',

  // ── door attendance terminal ───────────────────────────────────────────────
  /** View terminals, cards and the unknown-card enrolment list. */
  DOOR_READ: 'door.read',
  /**
   * Register and revoke terminals, and manage cards (add, label, revoke, mark lost, temporary
   * windows). One manage code for cards and terminals on purpose — HR and IT admins both hold it,
   * and the audit log shows who did what.
   */
  DOOR_MANAGE: 'door.manage',
} as const;

/** Union of every valid permission code. A typo is a compile error. */
export type Permission = (typeof PERMISSION)[keyof typeof PERMISSION];

/**
 * Super-admin grant. Held only by the `admin` role and checked before anything
 * else, so it needs no entry in {@link PERMISSION} — it is not a capability, it
 * is the absence of a limit.
 */
export const WILDCARD_PERMISSION = '*';

/** Human-readable purpose per code. Seeded into `authz.permissions.description`. */
export const PERMISSION_DESCRIPTIONS: Record<Permission, string> = {
  [PERMISSION.RBAC_READ]: 'View roles, permissions and assignments',
  [PERMISSION.RBAC_MANAGE]: 'Create / edit / delete roles and permissions',
  [PERMISSION.ROLE_ASSIGN]: 'Grant and revoke role assignments',
  [PERMISSION.EMPLOYEE_READ]: 'View employee directory records',
  [PERMISSION.EMPLOYEE_WRITE]: 'Create and update employee records',
  [PERMISSION.POSITION_READ]: 'View positions, approved headcount and occupancy',
  [PERMISSION.POSITION_MANAGE]: 'Define positions and assign employees to them',
  [PERMISSION.CONTRACT_READ]: 'View employment contracts (excluding pay)',
  [PERMISSION.CONTRACT_MANAGE]: 'Draft, activate, renew and terminate employment contracts',
  [PERMISSION.CONTRACT_COMPENSATION_READ]: 'See the pay figures on an employment contract',
  [PERMISSION.TRAINING_READ]: 'View training courses, requirements and records',
  [PERMISSION.TRAINING_MANAGE]: 'Manage courses and requirements; verify or revoke records',
  [PERMISSION.PERFORMANCE_READ]: 'View performance cycles, reviews and the coverage report',
  [PERMISSION.PERFORMANCE_MANAGE]: 'Open and close review cycles, create reviews, set goals',
  [PERMISSION.PERFORMANCE_APPROVE]: 'Sign off a performance rating before it is shared',
  [PERMISSION.RISK_READ]: 'View the risk register and treatment plans',
  [PERMISSION.RISK_MANAGE]: 'Identify, score, treat and close risks',
  [PERMISSION.RISK_ACCEPT]: 'Approve accepting a residual risk',
  [PERMISSION.CONTROL_READ]: 'View controls and the Statement of Applicability',
  [PERMISSION.CONTROL_MANAGE]: 'Maintain controls and the Statement of Applicability',
  [PERMISSION.INCIDENT_READ]: 'View security incidents and their timelines',
  [PERMISSION.INCIDENT_MANAGE]: 'Triage, contain, resolve and close security incidents',
  [PERMISSION.INFORMATION_ASSET_READ]: 'View the information asset register and its history',
  [PERMISSION.INFORMATION_ASSET_MANAGE]:
    'Register information assets, rate them and raise their classification',
  [PERMISSION.INFORMATION_ASSET_DECLASSIFY]: 'Lower the classification of an information asset',
  [PERMISSION.VENDOR_READ]: 'View the supplier register and its assessments',
  [PERMISSION.VENDOR_MANAGE]: 'Register suppliers, assess them, suspend and terminate',
  [PERMISSION.VENDOR_APPROVE]: 'Approve a supplier for live use',
  [PERMISSION.NONCONFORMANCE_READ]: 'View the non-conformance register and its corrective actions',
  [PERMISSION.NONCONFORMANCE_MANAGE]: 'Grade, contain, close and void non-conformances',
  [PERMISSION.CAPA_MANAGE]: 'Open, analyse, plan and implement corrective actions',
  [PERMISSION.CAPA_VERIFY]: 'Sign off that a corrective action was effective',
  [PERMISSION.INTERNAL_AUDIT_READ]: 'View the internal audit programme and its findings',
  [PERMISSION.INTERNAL_AUDIT_MANAGE]: 'Plan, roster, run, report and close internal audits',
  [PERMISSION.MANAGEMENT_REVIEW_READ]: 'View management reviews, their agenda and their actions',
  [PERMISSION.MANAGEMENT_REVIEW_MANAGE]: 'Schedule, hold and close management reviews',
  [PERMISSION.EMPLOYEE_OFFBOARD]: 'Trigger offboarding and revoke all access',
  [PERMISSION.ASSET_READ]: 'View hardware asset inventory',
  [PERMISSION.ASSET_WRITE]: 'Create and update asset records',
  [PERMISSION.ASSET_REASSIGN]: 'Reassign assets between employees',
  [PERMISSION.ACCESS_REQUEST_READ]: 'View privileged-access requests',
  [PERMISSION.REQUEST_READ]: 'View requests you are not the requester or approver of',
  [PERMISSION.ACCESS_REQUEST_APPROVE]: 'Step-1 approval for access requests (manager tier)',
  [PERMISSION.ACCESS_REQUEST_SECURITY_APPROVE]: 'Step-2 IT-Security approval for access requests',
  [PERMISSION.COMPLIANCE_READ]: 'View compliance findings and software catalog',
  [PERMISSION.COMPLIANCE_MANAGE]: 'Resolve findings and manage compliance data',
  [PERMISSION.WORKFORCE_READ]: 'View timesheets, leave and overtime entries',
  [PERMISSION.WORKFORCE_MANAGE]: 'Manage the holiday calendar and annual leave entitlements',
  [PERMISSION.WORKFORCE_APPROVE]: 'Approve or reject workforce requests (legacy)',
  [PERMISSION.WORKFORCE_LEAVE_REVIEW]: 'Approve or reject leave requests via the approval engine',
  [PERMISSION.WORKFORCE_OVERTIME_REVIEW]:
    'Approve or reject overtime requests via the approval engine',
  [PERMISSION.ONBOARDING_APPROVE]: 'Step-1: Manager approves new employee hire',
  [PERMISSION.ONBOARDING_PROVISION]: 'Step-2: IT provisions accounts and equipment',
  [PERMISSION.ONBOARDING_COMPLETE]: 'Step-3: HR marks onboarding complete',
  [PERMISSION.OFFBOARDING_APPROVE]: 'HR approves offboarding and triggers full access revocation',
  [PERMISSION.AUDIT_READ]: 'Read the immutable audit log',
  [PERMISSION.REPORTS_READ]: 'View aggregate reports and analytics dashboards',
  [PERMISSION.SECURITY_VIEW]: 'View Secure Score trends and baseline drift checks',
  [PERMISSION.SECURITY_MANAGE]: 'Trigger Graph sync and manage security posture data',
  [PERMISSION.NOTIFICATIONS_MANAGE]: 'Manage notification preferences for all users',
  [PERMISSION.WEBHOOKS_MANAGE]: 'Create and manage outbound webhook subscriptions',
  [PERMISSION.CATALOG_MANAGE]: 'Create / edit / delete service catalog items',
  [PERMISSION.CATALOG_APPROVE]: 'Approve a service-catalog request',
  [PERMISSION.DOCUMENTS_READ]: 'View all controlled documents, including drafts',
  [PERMISSION.DOCUMENTS_MANAGE]: 'Author controlled documents and open new drafts',
  [PERMISSION.DOCUMENTS_APPROVE]: 'Approve a controlled-document version',
  [PERMISSION.DOCUMENTS_PUBLISH]: 'Put an approved document version into force',
  [PERMISSION.LICENSE_READ]: 'View software licenses, seats and utilization',
  [PERMISSION.LICENSE_MANAGE]: 'Create / edit licenses and assign / revoke seats',
  [PERMISSION.DOOR_READ]: 'View door terminals, cards and the unknown-card list',
  [PERMISSION.DOOR_MANAGE]: 'Register/revoke terminals; add, edit, revoke and mark cards lost',
};

/**
 * The module a code belongs to — its first segment. Derived rather than declared
 * so adding a module cannot forget to register it, and so a rename of the prefix
 * cannot leave a stale mapping behind.
 *
 * `workforce.leave.review` → `workforce`, i.e. the module is the FIRST segment,
 * not everything before the last dot. Sub-namespaces belong to their module.
 */
export function moduleOf(permission: string): string {
  return permission.split('.')[0] ?? permission;
}

/** Every module present in the catalogue, sorted. Useful for grouping a UI. */
export function permissionModules(): string[] {
  return [...new Set(Object.values(PERMISSION).map(moduleOf))].sort();
}

/**
 * The ONE wildcard-aware permission check, so the semantics cannot drift between
 * the guard, the services and the frontend. A holder of `held` is granted
 * `required` when any of these is true:
 *
 *   - `*`        — the super-admin grant
 *   - exact code — `asset.read` grants `asset.read`
 *   - `<module>.*` — a module-wide grant, e.g. `asset.*` grants `asset.reassign`
 *
 * The module wildcard is deliberately supported before any role uses one: an
 * internal platform grows by module, and "owns everything in Assets" is the grant
 * a real org hands out. Supporting it here means a future role bundle is a data
 * change, not a code change. Deny by default.
 */
export function permissionGrants(held: readonly string[] | undefined, required: string): boolean {
  if (!held?.length) return false;
  if (held.includes(WILDCARD_PERMISSION) || held.includes(required)) return true;
  return held.includes(`${moduleOf(required)}.*`);
}

// ── Roles ────────────────────────────────────────────────────────────────────

export const ROLE = {
  ADMIN: 'admin',
  IT_ADMIN: 'it-admin',
  SECURITY: 'security',
  HR: 'hr',
  MANAGER: 'manager',
  HELPDESK: 'helpdesk',
  AUDITOR: 'auditor',
  EMPLOYEE: 'employee',
} as const;

/** Union of every valid system-role key. */
export type RoleKey = (typeof ROLE)[keyof typeof ROLE];

export const ROLE_NAMES: Record<RoleKey, string> = {
  [ROLE.ADMIN]: 'Platform Administrator',
  [ROLE.IT_ADMIN]: 'IT Administrator',
  [ROLE.SECURITY]: 'Security Officer',
  [ROLE.HR]: 'HR Manager',
  [ROLE.MANAGER]: 'People Manager',
  [ROLE.HELPDESK]: 'Help Desk',
  [ROLE.AUDITOR]: 'Auditor (read-only)',
  [ROLE.EMPLOYEE]: 'Employee',
};

/**
 * Role → permission bundles, seeded into `authz.role_permissions`.
 *
 * `admin` holds only the wildcard, deliberately: enumerating every code for it
 * would need editing here on every new permission, and a missed edit would make
 * the platform administrator quietly less privileged than intended.
 *
 * `employee` holds nothing. Every user gets it, and self-service access (submit a
 * request, read your own records) is expressed by the `self` SCOPE on a grant,
 * not by a permission code — so an empty bundle here is correct, not a stub.
 */
export const ROLE_PERMISSIONS: Record<
  RoleKey,
  readonly (Permission | typeof WILDCARD_PERMISSION)[]
> = {
  [ROLE.ADMIN]: [WILDCARD_PERMISSION],

  [ROLE.IT_ADMIN]: [
    PERMISSION.EMPLOYEE_READ,
    PERMISSION.EMPLOYEE_WRITE,
    PERMISSION.ASSET_READ,
    PERMISSION.ASSET_WRITE,
    PERMISSION.ASSET_REASSIGN,
    PERMISSION.ACCESS_REQUEST_READ,
    PERMISSION.REQUEST_READ,
    PERMISSION.ACCESS_REQUEST_APPROVE,
    PERMISSION.ACCESS_REQUEST_SECURITY_APPROVE,
    PERMISSION.COMPLIANCE_READ,
    PERMISSION.SECURITY_VIEW,
    PERMISSION.SECURITY_MANAGE,
    PERMISSION.AUDIT_READ,
    PERMISSION.REPORTS_READ,
    PERMISSION.RBAC_READ,
    PERMISSION.ONBOARDING_PROVISION,
    PERMISSION.WEBHOOKS_MANAGE,
    PERMISSION.CATALOG_MANAGE,
    PERMISSION.CATALOG_APPROVE,
    PERMISSION.DOCUMENTS_READ,
    PERMISSION.LICENSE_READ,
    PERMISSION.LICENSE_MANAGE,
    // The physical device side of the door: registering terminals and rotating their tokens.
    PERMISSION.DOOR_READ,
    PERMISSION.DOOR_MANAGE,
  ],

  [ROLE.SECURITY]: [
    PERMISSION.COMPLIANCE_READ,
    PERMISSION.COMPLIANCE_MANAGE,
    PERMISSION.SECURITY_VIEW,
    PERMISSION.SECURITY_MANAGE,
    PERMISSION.RISK_READ,
    PERMISSION.RISK_MANAGE,
    PERMISSION.CONTROL_READ,
    PERMISSION.CONTROL_MANAGE,
    PERMISSION.INCIDENT_READ,
    PERMISSION.INCIDENT_MANAGE,
    PERMISSION.INFORMATION_ASSET_READ,
    PERMISSION.INFORMATION_ASSET_MANAGE,
    PERMISSION.VENDOR_READ,
    PERMISSION.VENDOR_MANAGE,
    PERMISSION.NONCONFORMANCE_READ,
    PERMISSION.NONCONFORMANCE_MANAGE,
    PERMISSION.CAPA_MANAGE,
    PERMISSION.INTERNAL_AUDIT_READ,
    PERMISSION.INTERNAL_AUDIT_MANAGE,
    PERMISSION.MANAGEMENT_REVIEW_READ,
    PERMISSION.MANAGEMENT_REVIEW_MANAGE,
    // Deliberately WITHOUT `CAPA_VERIFY`, on the same reasoning that keeps `RISK_ACCEPT`,
    // `INFORMATION_ASSET_DECLASSIFY` and `VENDOR_APPROVE` out of every bundle.
    // Deliberately WITHOUT `VENDOR_APPROVE`, on the same reasoning that keeps `RISK_ACCEPT` and
    // `INFORMATION_ASSET_DECLASSIFY` out of every bundle.
    // Deliberately WITHOUT `INFORMATION_ASSET_DECLASSIFY`, on the same reasoning that keeps
    // `RISK_ACCEPT` out of every bundle: the role that classifies information should not be able to
    // reduce that protection unilaterally.
    PERMISSION.ACCESS_REQUEST_READ,
    PERMISSION.ACCESS_REQUEST_APPROVE,
    PERMISSION.ACCESS_REQUEST_SECURITY_APPROVE,
    PERMISSION.DOCUMENTS_READ,
    PERMISSION.DOCUMENTS_MANAGE,
    PERMISSION.DOCUMENTS_APPROVE,
    PERMISSION.DOCUMENTS_PUBLISH,
    PERMISSION.REQUEST_READ,
    PERMISSION.AUDIT_READ,
    PERMISSION.REPORTS_READ,
    PERMISSION.LICENSE_READ,
  ],

  [ROLE.HR]: [
    PERMISSION.EMPLOYEE_READ,
    PERMISSION.EMPLOYEE_WRITE,
    PERMISSION.EMPLOYEE_OFFBOARD,
    PERMISSION.POSITION_READ,
    PERMISSION.POSITION_MANAGE,
    PERMISSION.CONTRACT_READ,
    PERMISSION.CONTRACT_MANAGE,
    PERMISSION.CONTRACT_COMPENSATION_READ,
    PERMISSION.TRAINING_READ,
    PERMISSION.TRAINING_MANAGE,
    PERMISSION.PERFORMANCE_READ,
    PERMISSION.PERFORMANCE_MANAGE,
    // HR calibrates: the second pair of eyes on a rating before the employee sees it.
    PERMISSION.PERFORMANCE_APPROVE,
    PERMISSION.WORKFORCE_READ,
    PERMISSION.WORKFORCE_APPROVE,
    PERMISSION.WORKFORCE_LEAVE_REVIEW,
    PERMISSION.WORKFORCE_OVERTIME_REVIEW,
    PERMISSION.WORKFORCE_MANAGE,
    PERMISSION.DOCUMENTS_READ,
    PERMISSION.DOCUMENTS_MANAGE,
    PERMISSION.REQUEST_READ,
    PERMISSION.AUDIT_READ,
    PERMISSION.REPORTS_READ,
    PERMISSION.ONBOARDING_APPROVE,
    PERMISSION.ONBOARDING_COMPLETE,
    PERMISSION.OFFBOARDING_APPROVE,
    // Cards are an HR act (who may come in), not an IT one; one manage code for cards and
    // terminals — the audit log tells the two kinds of work apart.
    PERMISSION.DOOR_READ,
    PERMISSION.DOOR_MANAGE,
  ],

  [ROLE.MANAGER]: [
    PERMISSION.EMPLOYEE_READ,
    PERMISSION.POSITION_READ,
    PERMISSION.TRAINING_READ,
    // Read, but NOT `PERFORMANCE_APPROVE`: a manager writes the review, so approving it would make
    // the calibration step a formality. Rating a review they were ASSIGNED needs no code — the
    // reviewer is named on the row, which is a scope rule.
    PERMISSION.PERFORMANCE_READ,
    PERMISSION.WORKFORCE_READ,
    PERMISSION.WORKFORCE_APPROVE,
    PERMISSION.WORKFORCE_LEAVE_REVIEW,
    PERMISSION.WORKFORCE_OVERTIME_REVIEW,
    PERMISSION.ACCESS_REQUEST_READ,
    PERMISSION.ACCESS_REQUEST_APPROVE,
    PERMISSION.REQUEST_READ,
    PERMISSION.REPORTS_READ,
    PERMISSION.ONBOARDING_APPROVE,
  ],

  [ROLE.HELPDESK]: [
    PERMISSION.ASSET_READ,
    PERMISSION.ASSET_WRITE,
    PERMISSION.ACCESS_REQUEST_READ,
    PERMISSION.REQUEST_READ,
    PERMISSION.EMPLOYEE_READ,
  ],

  [ROLE.AUDITOR]: [
    PERMISSION.RBAC_READ,
    PERMISSION.AUDIT_READ,
    PERMISSION.COMPLIANCE_READ,
    PERMISSION.SECURITY_VIEW,
    PERMISSION.EMPLOYEE_READ,
    PERMISSION.ASSET_READ,
    PERMISSION.POSITION_READ,
    // Deliberately WITHOUT `CONTRACT_COMPENSATION_READ`: an auditor checks that every employee has
    // a signed contract, which does not require knowing what any of them pays.
    PERMISSION.CONTRACT_READ,
    PERMISSION.TRAINING_READ,
    // Deliberately WITHOUT `PERFORMANCE_READ`. A performance review is a personal judgement about
    // somebody, not compliance evidence: the competency artefact an ISO audit looks for is the
    // TRAINING record, which the auditor does hold. If an audit ever needs review coverage without
    // the contents, that is a separate read code for the coverage report, not this one widened.
    PERMISSION.RISK_READ,
    PERMISSION.CONTROL_READ,
    PERMISSION.INCIDENT_READ,
    PERMISSION.INFORMATION_ASSET_READ,
    PERMISSION.VENDOR_READ,
    PERMISSION.NONCONFORMANCE_READ,
    PERMISSION.INTERNAL_AUDIT_READ,
    PERMISSION.MANAGEMENT_REVIEW_READ,
    PERMISSION.REQUEST_READ,
    PERMISSION.DOCUMENTS_READ,
    PERMISSION.REPORTS_READ,
    PERMISSION.LICENSE_READ,
    // Door events are compliance evidence (who entered, when); manage stays with hr/it-admin.
    PERMISSION.DOOR_READ,
  ],

  [ROLE.EMPLOYEE]: [],
};
