/**
 * Shared enums (Postgres enum types). Imported by table definitions — keep first.
 */
import { pgEnum } from 'drizzle-orm/pg-core';

// ── Identity ─────────────────────────────────────────────────────────────────
export const employeeStatusEnum = pgEnum('employee_status', ['active', 'on_leave', 'offboarded']);

// ── Authorization (RBAC scopes) ──────────────────────────────────────────────
export const scopeTypeEnum = pgEnum('scope_type', ['global', 'self', 'team', 'dept', 'region']);

// ── Universal Request Engine ─────────────────────────────────────────────────
export const requestStatusEnum = pgEnum('request_status', [
  'pending',
  'in_review',
  'approved',
  'rejected',
  'cancelled',
  'expired',
]);
export const requestPriorityEnum = pgEnum('request_priority', ['low', 'normal', 'high', 'urgent']);

// ── Assets ───────────────────────────────────────────────────────────────────
export const assetTypeEnum = pgEnum('asset_type', [
  'laptop',
  'desktop',
  'monitor',
  'phone',
  'tablet',
  'peripheral',
  'other',
]);
export const assetStatusEnum = pgEnum('asset_status', [
  'in_stock',
  'assigned',
  'in_repair',
  'retired',
  'lost',
]);

// ── Access requests (privileged / temp-admin) ────────────────────────────────
export const accessRequestStatusEnum = pgEnum('access_request_status', [
  'pending',
  'approved',
  'rejected',
  'expired',
  'revoked',
]);
export const accessTypeEnum = pgEnum('access_type', [
  'local_admin',
  'pim_role',
  'app_admin',
  'vpn',
  'other',
]);

// ── Compliance ───────────────────────────────────────────────────────────────
export const findingStatusEnum = pgEnum('finding_status', [
  'open',
  'acknowledged',
  'resolved',
  'risk_accepted',
]);
export const findingSeverityEnum = pgEnum('finding_severity', [
  'low',
  'medium',
  'high',
  'critical',
]);
export const softwareListingEnum = pgEnum('software_listing', [
  'whitelisted',
  'blacklisted',
  'review',
]);

// ── Workforce ────────────────────────────────────────────────────────────────
export const timesheetStatusEnum = pgEnum('timesheet_status', [
  'draft',
  'submitted',
  'approved',
  'rejected',
]);
export const leaveTypeEnum = pgEnum('leave_type', [
  'annual',
  'sick',
  'unpaid',
  'parental',
  'other',
]);
export const leaveStatusEnum = pgEnum('leave_status', [
  'pending',
  'approved',
  'rejected',
  'cancelled',
]);
export const overtimeStatusEnum = pgEnum('overtime_status', ['pending', 'approved', 'rejected']);
export const shiftTypeEnum = pgEnum('shift_type', ['night', 'on_call', 'weekend']);

// ── Storage ──────────────────────────────────────────────────────────────────
export const storedFileStatusEnum = pgEnum('stored_file_status', [
  'pending',
  'completed',
  'deleted',
]);

// ── License ───────────────────────────────────────────────────────────────────
// Value sets taken from the existing DTO Zod enums (the code-authoritative
// source), in libs/modules/license/src/interface/http/dto/license.dto.ts:
//   licenseTypeZ   = z.enum(['perpetual','subscription','per_seat','concurrent'])
//   licenseStatusZ = z.enum(['active','expiring_soon','expired','cancelled'])
// Schema must match the DTO so validated input round-trips to the column.
// Defaults in licenses.ts (license_type='subscription', status='active') are in-set.
export const licenseTypeEnum = pgEnum('license_type', [
  'perpetual',
  'subscription',
  'per_seat',
  'concurrent',
]);
export const licenseStatusEnum = pgEnum('license_status', [
  'active',
  'expiring_soon',
  'expired',
  'cancelled',
]);

/**
 * `bounced` and `complained` are EMAIL verdicts (migration 0032): written only by
 * BounceFeedbackService, overlaying a row already `sent`. They sit on the shared
 * outbox enum because email_outbox reuses it — webhook rows can never carry them.
 */
export const outboxStatusEnum = pgEnum('outbox_status', [
  'pending',
  'sent',
  'failed',
  'delivered',
  'bounced',
  'complained',
]);

export const requestDecisionEnum = pgEnum('request_decision', [
  'approved',
  'rejected',
  'delegated',
]);

export const baselineCheckCategoryEnum = pgEnum('baseline_check_category', [
  'asr',
  'firewall',
  'encryption',
  'endpoint',
  'identity',
  'other',
]);

export const baselineCheckStatusEnum = pgEnum('baseline_check_status', [
  'pass',
  'fail',
  'warning',
  'not_applicable',
]);

/**
 * Which management system a controlled document belongs to.
 *
 * The ONLY thing distinguishing a policy from an SOP from a handbook — everything else about their
 * lifecycle is identical, which is why they share one table rather than three.
 */
export const documentCategoryEnum = pgEnum('document_category', [
  'isms_policy',
  'qms_procedure',
  'work_instruction',
  'hr_handbook',
  'contract_template',
]);

/**
 * Lifecycle of one document VERSION.
 *
 * `published` is terminal-ish: the row becomes immutable and only `superseded` follows, because a
 * published revision is what someone was told to follow on a given date. Editing means a new
 * version, never a status walk backwards.
 */
export const documentVersionStatusEnum = pgEnum('document_version_status', [
  'draft',
  'in_review',
  'approved',
  'published',
  'superseded',
  'rejected',
]);

/**
 * Lifecycle of a job position.
 *
 * `frozen` is the state a hiring pause needs and a boolean cannot express: the position still
 * exists and its occupants keep it, but no new assignment may be made against it.
 */
export const positionStatusEnum = pgEnum('position_status', ['active', 'frozen', 'closed']);

/**
 * Kind of employment agreement.
 *
 * Drives whether an end date is REQUIRED or FORBIDDEN, which is a database CHECK rather than a
 * service convention: `permanent` with an end date is a fixed-term contract mislabelled, and a
 * `fixed_term` without one is an open-ended contract nobody approved.
 */
export const contractTypeEnum = pgEnum('contract_type', [
  'permanent',
  'fixed_term',
  'probation',
  'internship',
  'contractor',
]);

/**
 * Lifecycle of an employment contract.
 *
 * `draft` exists because a contract is negotiated before it binds anyone, and only `active`
 * competes for the one-per-employee slot. `expired` is reached by the passage of time and written
 * by the sweep; `terminated` is a decision somebody made and carries a reason.
 */
export const contractStatusEnum = pgEnum('contract_status', [
  'draft',
  'active',
  'expired',
  'terminated',
]);

/** What the base salary figure is PER — a number without this is not an amount. */
export const salaryPeriodEnum = pgEnum('salary_period', ['hourly', 'monthly', 'annual']);

/**
 * Whether a completed training still counts.
 *
 * `valid` and `expired` are the two real states; `expiring_soon` is NOT one of them — it is a
 * question about today's date relative to `expires_on`, so it is computed on read rather than
 * stored, and no sweep has to keep it true. Compare `contract_status`, where the sweep exists
 * because an expiry there changes what may happen next.
 */
export const trainingRecordStatusEnum = pgEnum('training_record_status', [
  'valid',
  'expired',
  'revoked',
]);

/** How a course requirement applies — the QMS competency distinction. */
export const trainingRequirementKindEnum = pgEnum('training_requirement_kind', [
  'mandatory',
  'recommended',
]);

/**
 * Where a risk is in its lifecycle.
 *
 * `assessed` means scored but untreated; `treated` means the treatment plan is complete and a
 * residual score has been recorded; `accepted` means somebody with authority chose to carry it.
 * `closed` is terminal — the risk no longer applies (the asset was retired, the process changed).
 *
 * There is deliberately no `expiring` state: "due for review" is a question about `review_due_on`
 * against today, so it is computed rather than stored. Compare `contract_status`, where the sweep
 * exists because an expiry there changes what may happen next.
 */
export const riskStatusEnum = pgEnum('risk_status', [
  'identified',
  'assessed',
  'treated',
  'accepted',
  'closed',
]);

/** The four ISO 27005 treatment options. Naming them exactly keeps an audit conversation short. */
export const riskTreatmentDecisionEnum = pgEnum('risk_treatment_decision', [
  'mitigate',
  'accept',
  'transfer',
  'avoid',
]);

/** Lifecycle of one action within a treatment plan. */
export const riskTreatmentStatusEnum = pgEnum('risk_treatment_status', [
  'planned',
  'in_progress',
  'done',
  'cancelled',
]);

/**
 * ISO 27002:2022 groups controls into four THEMES, replacing the 14 clauses of the 2013 edition.
 *
 * Stored as an enum rather than free text because the four are fixed by the standard and every SoA
 * export groups by them; a typo'd theme silently splits a section of the report in two.
 */
export const controlThemeEnum = pgEnum('control_theme', [
  'organizational',
  'people',
  'physical',
  'technological',
]);

/**
 * Where a control came from.
 *
 * `annex_a` controls are the standard's; `custom` ones are the organisation's own additions, which
 * ISO 27001 explicitly permits — the SoA has to state that Annex A was compared against, not that
 * nothing else exists.
 */
export const controlSourceEnum = pgEnum('control_source', ['annex_a', 'custom']);

/**
 * How far a control has actually been put in place.
 *
 * `not_applicable` is a status rather than a separate flag so the two cannot disagree: it is paired
 * with `applicable = false` by `ck_soa_applicability`, which means "excluded but implemented" is
 * unrepresentable.
 */
export const controlImplementationStatusEnum = pgEnum('control_implementation_status', [
  'not_applicable',
  'not_implemented',
  'partially_implemented',
  'implemented',
]);

/**
 * Where a security incident is in its handling.
 *
 * The order is the ISO 27035 sequence and it is one-way: `reported` → `triaged` → `contained` →
 * `resolved` → `closed`. A separate `false_positive` terminal state exists because "it turned out
 * not to be an incident" is a real outcome, and forcing it through `contained`/`resolved` would put
 * containment timestamps on something that never needed containing.
 */
export const incidentStatusEnum = pgEnum('incident_status', [
  'reported',
  'triaged',
  'contained',
  'resolved',
  'closed',
  'false_positive',
]);

/**
 * How bad it is. Named bands rather than 1..5 because an incident severity drives a RESPONSE
 * (who is woken up, what the deadline is), and a number invites arithmetic that means nothing.
 */
export const incidentSeverityEnum = pgEnum('incident_severity', [
  'low',
  'medium',
  'high',
  'critical',
]);

/**
 * What kind of entry a timeline row is.
 *
 * The timeline is append-only, so the type is how a reader distinguishes an automatic state change
 * from something a responder wrote.
 */
export const incidentEventTypeEnum = pgEnum('incident_event_type', [
  'status_change',
  'note',
  'evidence',
  'notification',
]);

// ── ISMS information assets ──────────────────────────────────────────────────
/**
 * The classification labels, in order of increasing protection.
 *
 * The ORDER OF THESE VALUES IS NOT THE RANKING. Postgres orders an enum by declaration order, so it
 * happens to agree today, but nothing keeps them in step: inserting a new label in the middle needs
 * `ALTER TYPE ... BEFORE`, and anybody appending one at the end would silently make it the highest.
 * The authoritative ranking is the `rank` column on `isms.classification_levels`, which is also
 * where the handling rules live — see that table.
 */
export const informationClassificationEnum = pgEnum('information_classification', [
  'public',
  'internal',
  'confidential',
  'restricted',
]);

/**
 * What kind of thing the information asset IS.
 *
 * Deliberately not the same list as `asset_type`, which enumerates devices (laptop, monitor, phone).
 * An information asset is the information and the thing that holds it — a payroll system, a customer
 * database, a room of signed contracts — and a device is a CONTAINER for one, linked through
 * `isms.information_asset_devices` rather than conflated with it.
 */
export const informationAssetTypeEnum = pgEnum('information_asset_type', [
  'system',
  'application',
  'database',
  'dataset',
  'repository',
  'document_set',
  'physical_record',
  'service',
  'other',
]);

// ── ISMS vendor risk ─────────────────────────────────────────────────────────
/**
 * How much of the organisation rests on this supplier.
 *
 * As with `information_classification`, THE ORDER OF THESE VALUES IS NOT THE RANKING — the
 * authoritative rank, and the review interval each tier demands, live on
 * `isms.vendor_criticality_levels`.
 */
export const vendorCriticalityEnum = pgEnum('vendor_criticality', [
  'low',
  'medium',
  'high',
  'critical',
]);

/**
 * Where the supplier stands with us.
 *
 * `prospective` is the state a vendor is registered in: assessed but not yet relied upon. Going
 * `active` is the act that creates exposure, which is why it needs its own permission and its own
 * preconditions — see `VendorService`.
 */
export const vendorStatusEnum = pgEnum('vendor_status', [
  'prospective',
  'active',
  'suspended',
  'terminated',
]);

/**
 * The outcome of a due-diligence assessment.
 *
 * `pass_with_conditions` is the honest middle that a pass/fail pair forces people to lie about: the
 * supplier is usable, and something has to be fixed by a date. The conditions are then REQUIRED —
 * see `ck_vendor_assessment_conditions`.
 */
export const vendorAssessmentOutcomeEnum = pgEnum('vendor_assessment_outcome', [
  'pass',
  'pass_with_conditions',
  'fail',
]);

// ── QMS non-conformance and CAPA ─────────────────────────────────────────────
/**
 * How the non-conformance came to light.
 *
 * `incident` and `supplier` exist so the QMS does not become a parallel universe: a security
 * incident or a supplier failure that also breaches a quality requirement is ONE finding with a
 * pointer back, not a retyped copy.
 */
export const nonconformanceSourceEnum = pgEnum('nonconformance_source', [
  'internal_audit',
  'external_audit',
  'customer_complaint',
  'process_monitoring',
  'employee_report',
  'supplier',
  'incident',
  'other',
]);

/**
 * How serious the breach is.
 *
 * As with `information_classification` and `vendor_criticality`, THE ORDER OF THESE VALUES IS NOT
 * THE RANKING — the rank, and the policy each grade carries (whether a CAPA is mandatory, how long
 * containment may take), live on `qms.nonconformance_severities`.
 *
 * `observation` is included deliberately: an auditor's "this would fail next year" is worth
 * recording, and forcing it to be called a minor non-conformance is how observations stop being
 * raised at all.
 */
export const nonconformanceSeverityEnum = pgEnum('nonconformance_severity', [
  'observation',
  'minor',
  'major',
  'critical',
]);

/**
 * Where the finding stands.
 *
 * `void` is for one raised in error — kept rather than deleted, because "we looked and there was
 * nothing wrong" is itself a record an auditor may ask about.
 */
export const nonconformanceStatusEnum = pgEnum('nonconformance_status', [
  'open',
  'contained',
  'closed',
  'void',
]);

/**
 * The CAPA lifecycle.
 *
 * `ineffective` is not terminal — it returns to `analysis`. That loop is the whole point of ISO 9001
 * §10.2(d): the effectiveness review can FAIL, and a process where failing it quietly closes the
 * record is the box-ticking the clause exists to prevent.
 */
export const capaStatusEnum = pgEnum('capa_status', [
  'analysis',
  'planned',
  'in_progress',
  'implemented',
  'verified',
  'ineffective',
  'cancelled',
]);

/** How the root cause was established. Recorded because "we thought about it" is not a method. */
export const capaRootCauseMethodEnum = pgEnum('capa_root_cause_method', [
  'five_whys',
  'fishbone',
  'fault_tree',
  'pareto',
  'other',
]);

// ── QMS internal audit ───────────────────────────────────────────────────────
/**
 * Where an audit engagement stands.
 *
 * `reported` is a state and not a timestamp on `closed` because ISO 9001 §9.2.2(d) makes reporting
 * to management its own obligation: an audit whose fieldwork finished and whose results were never
 * reported has not been done, and collapsing the two would make that unrepresentable.
 */
export const internalAuditStatusEnum = pgEnum('internal_audit_status', [
  'planned',
  'in_progress',
  'reported',
  'closed',
  'cancelled',
]);

/**
 * What a person does on an audit.
 *
 * `observer` exists so that somebody being trained, or an auditee's representative sitting in, is
 * recorded without counting as an auditor — which matters, because the impartiality rule keys off
 * who actually audited.
 */
export const auditRoleEnum = pgEnum('audit_role', ['lead', 'auditor', 'observer']);

// ── QMS management review ────────────────────────────────────────────────────
/**
 * Where a management review stands.
 *
 * `held` and `closed` are separate for the same reason an audit's `reported` and `closed` are:
 * §9.3.3 requires the review to produce documented outputs, so a meeting that happened and whose
 * minutes were never issued is not a completed review. Collapsing the two would make that
 * unrepresentable.
 */
export const managementReviewStatusEnum = pgEnum('management_review_status', [
  'scheduled',
  'held',
  'closed',
  'cancelled',
]);

/**
 * The three outputs ISO 9001 §9.3.3 names, and nothing else.
 *
 * The clause is a closed list — "decisions and actions related to opportunities for improvement, any
 * need for changes to the quality management system, resource needs" — so this enum IS the clause.
 * An `other` value would let every action be filed as unclassifiable, which is exactly what the list
 * exists to prevent.
 */
export const managementReviewActionCategoryEnum = pgEnum('management_review_action_category', [
  'improvement',
  'qms_change',
  'resource_need',
]);

/** Where one review action stands. */
export const managementReviewActionStatusEnum = pgEnum('management_review_action_status', [
  'open',
  'in_progress',
  'completed',
  'cancelled',
]);

// ── TMS leave accrual ────────────────────────────────────────────────────────
/**
 * How a year's granted days become AVAILABLE.
 *
 * `annual_grant` makes the whole year's entitlement available on 1 January; `monthly_accrual` earns
 * it a twelfth at a time. The distinction is only about availability — neither changes how many days
 * the year carries, which is `leave_entitlements.granted_days` and set by HR.
 */
export const leaveAccrualMethodEnum = pgEnum('leave_accrual_method', [
  'annual_grant',
  'monthly_accrual',
]);

/**
 * Which part of a day a leave window's boundary falls on — see migration 0028.
 *
 * A window runs from `start_date` at `start_portion` to `end_date` at `end_portion`, so a lone
 * afternoon costs half a day and leave from Wednesday afternoon to Friday morning costs two.
 * `full_day` is the default, which is what makes part-day leave additive rather than a change to
 * every request that came before it.
 *
 * Half days and not hours: the entitlement is denominated in DAYS throughout, and OpsHub has no
 * hours-per-day figure anywhere to convert with — no organisation settings, no contract hours — so
 * an hours column would put a second, unowned unit inside the balance arithmetic.
 */
export const leaveDayPortionEnum = pgEnum('leave_day_portion', [
  'full_day',
  'morning',
  'afternoon',
]);

// ── EMS performance reviews ──────────────────────────────────────────────────

/** Lifecycle of a review CYCLE — see migration 0029. */
export const performanceCycleStatusEnum = pgEnum('performance_cycle_status', [
  'draft',
  'open',
  'closed',
]);

/**
 * Lifecycle of one employee's review within a cycle.
 *
 * `self_assessment` → `manager_review` → `pending_approval` → `shared` → `acknowledged`, with
 * `cancelled` reachable from anywhere before sharing. The calibration sign-off is the request
 * engine's, which is why `pending_approval` is a state of the review and not a second approver
 * column: an approval is an approval, and OpsHub has one spine for those.
 */
export const performanceReviewStatusEnum = pgEnum('performance_review_status', [
  'self_assessment',
  'manager_review',
  'pending_approval',
  'shared',
  'acknowledged',
  'cancelled',
]);

/**
 * The rating vocabulary. A SET OF NAMES — the ordering lives in `performance.rating_scale.rank`.
 *
 * Declaration order here is not the scale: sorting a distribution report by it would be sorting by
 * an accident of how the type was written, and inserting a grade later would silently reorder every
 * historical report. The reference table also carries `requires_development_plan`, which is the
 * only thing that makes a low rating actionable.
 */
export const performanceRatingEnum = pgEnum('performance_rating', [
  'unsatisfactory',
  'needs_improvement',
  'meets',
  'exceeds',
  'outstanding',
]);
