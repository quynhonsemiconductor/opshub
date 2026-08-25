import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { queryBoolean } from '@platform';
import { PaginationQuerySchema } from '@shared-kernel';
import {
  auditRoleEnum,
  capaRootCauseMethodEnum,
  managementReviewActionCategoryEnum,
  managementReviewActionStatusEnum,
  managementReviewStatusEnum,
  capaStatusEnum,
  internalAuditStatusEnum,
  nonconformanceSeverityEnum,
  nonconformanceSourceEnum,
  nonconformanceStatusEnum,
} from '@db/schema/enums';

const severity = z.enum(nonconformanceSeverityEnum.enumValues);
const source = z.enum(nonconformanceSourceEnum.enumValues);
const ncStatus = z.enum(nonconformanceStatusEnum.enumValues);
const capaStatus = z.enum(capaStatusEnum.enumValues);
const rootCauseMethod = z.enum(capaRootCauseMethodEnum.enumValues);

/** 10 characters minimum, matching the substance CHECKs and the services' refusals. */
const substantial = z.string().min(10).max(5000);

/** A reference quoted in audit reports. Uppercase so it reads the same everywhere it is cited. */
const reference = (example: string) =>
  z
    .string()
    .min(3)
    .max(40)
    .regex(
      /^[A-Z][A-Z0-9.-]*$/,
      `Use uppercase letters, digits, dots and hyphens, e.g. ${example}`,
    );

export const RaiseNonconformanceSchema = z.object({
  reference: reference('NC-2026-014'),
  title: z.string().min(5).max(200),
  description: substantial,
  /** The clause, procedure or specification that was not met. */
  requirement: z.string().min(5).max(2000),
  source,
  severity,
  processArea: z.string().min(2).max(120),
  ownerId: z.string().uuid(),
  /** When it was FOUND. Every containment deadline counts from here, not from the form. */
  detectedAt: z.string().datetime().optional(),
  /** The security incident this finding also describes, when there is one. */
  incidentId: z.string().uuid().nullable().optional(),
  /**
   * The internal audit that raised it — §9.2.
   *
   * Optional even when `source` is `internal_audit`: a finding written up during fieldwork before the
   * engagement row exists is the normal order of events. Linking it is what puts it on the audit's
   * finding list, off the unlinked-findings report, AND under the impartiality rule — an auditor
   * cannot sign off the effectiveness of a fix for a finding the roster shows they found.
   */
  internalAuditId: z.string().uuid().nullable().optional(),
  evidenceDocumentId: z.string().uuid().nullable().optional(),
});
export class RaiseNonconformanceDto extends createZodDto(RaiseNonconformanceSchema) {}

/**
 * `status` and every state timestamp are absent DELIBERATELY.
 *
 * Those belong to the lifecycle routes, which check preconditions a patch would bypass — closing
 * through a PATCH would skip the CAPA gate entirely. `severity` IS settable: re-grading on better
 * information is ordinary work, and the gate then reads the new grade.
 */
export const UpdateNonconformanceSchema = RaiseNonconformanceSchema.omit({ reference: true })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Supply at least one field to update');
export class UpdateNonconformanceDto extends createZodDto(UpdateNonconformanceSchema) {}

export const ContainNonconformanceSchema = z.object({
  /** The immediate fix. Required by `ck_nc_contained_pair`. */
  containmentAction: substantial,
  /** When it was contained. Defaults to now; supplied when writing up after the fact. */
  containedAt: z.string().datetime().optional(),
});
export class ContainNonconformanceDto extends createZodDto(ContainNonconformanceSchema) {}

export const CloseNonconformanceSchema = z.object({
  /** Why it can be closed. Required by `ck_nc_closed_pair`. */
  closureNote: substantial,
});
export class CloseNonconformanceDto extends createZodDto(CloseNonconformanceSchema) {}

export const VoidNonconformanceSchema = z.object({
  /** Why it was raised in error. Required by `ck_nc_void_clean`. */
  reason: substantial,
});
export class VoidNonconformanceDto extends createZodDto(VoidNonconformanceSchema) {}

export const ListNonconformancesQuerySchema = z
  .object({
    status: ncStatus.optional(),
    severity: severity.optional(),
    source: source.optional(),
    ownerId: z.string().uuid().optional(),
    processArea: z.string().max(120).optional(),
    /** Everything not closed or void — the work queue. */
    openOnly: queryBoolean().optional(),
    /** Only grades whose policy makes a corrective action mandatory. */
    capaRequiredOnly: queryBoolean().optional(),
    search: z.string().max(200).optional(),
  })
  .merge(PaginationQuerySchema);
export class ListNonconformancesQueryDto extends createZodDto(ListNonconformancesQuerySchema) {}

// ── CAPAs ─────────────────────────────────────────────────────────────────────

export const OpenCapaSchema = z.object({
  reference: reference('CAPA-2026-007'),
  ownerId: z.string().uuid(),
  dueOn: z.string().date().nullable().optional(),
});
export class OpenCapaDto extends createZodDto(OpenCapaSchema) {}

export const CapaAnalysisSchema = z.object({
  /** Why it happened. Required before the CAPA may be planned. */
  rootCause: substantial,
  /** How that was established — "we thought about it" is not a method. */
  rootCauseMethod,
  /** What will be done. Required before the CAPA may be planned. */
  actionPlan: substantial,
  dueOn: z.string().date().nullable().optional(),
});
export class CapaAnalysisDto extends createZodDto(CapaAnalysisSchema) {}

export const MarkImplementedSchema = z.object({
  /** When the actions were completed. Defaults to now. */
  implementedAt: z.string().datetime().optional(),
});
export class MarkImplementedDto extends createZodDto(MarkImplementedSchema) {}

export const VerifyCapaSchema = z.object({
  /** What was checked, and what it showed. Required by `ck_capa_verified_pair`. */
  effectivenessEvidence: substantial,
});
export class VerifyCapaDto extends createZodDto(VerifyCapaSchema) {}

export const CapaOutcomeSchema = z.object({
  /** Why the review failed, or why the CAPA was cancelled. Required by `ck_capa_outcome_note`. */
  reason: substantial,
});
export class CapaOutcomeDto extends createZodDto(CapaOutcomeSchema) {}

export const ListCapasQuerySchema = z
  .object({
    status: capaStatus.optional(),
    ownerId: z.string().uuid().optional(),
    nonconformanceId: z.string().uuid().optional(),
    /** Everything not verified or cancelled — the work queue. */
    openOnly: queryBoolean().optional(),
    /** Due on or before this date. Today's date gives the overdue report. */
    dueOnOrBefore: z.string().date().optional(),
  })
  .merge(PaginationQuerySchema);
export class ListCapasQueryDto extends createZodDto(ListCapasQuerySchema) {}

// ── Responses ─────────────────────────────────────────────────────────────────

export class NonconformanceSeverityResponseDto {
  code!: string;
  /** Higher is worse. THE ordering — the enum's declaration order is not authoritative. */
  rank!: number;
  label!: string;
  description!: string;
  /** Whether closing at this grade requires a corrective action verified effective. */
  requiresCapa!: boolean;
  containmentDueDays!: number;
}

export class NonconformanceResponseDto {
  id!: string;
  reference!: string;
  title!: string;
  description!: string;
  requirement!: string;
  source!: string;
  severity!: string;
  status!: string;
  processArea!: string;
  ownerId!: string;
  /**
   * The owner's display name, resolved server-side.
   *
   * NULLABLE because the finding outlives the person accountable for it. A leaver's employee row can
   * go while the non-conformance and its CAPAs stay as the §10.2 evidence, so this is a LEFT lookup
   * and never a join — dropping a finding because its owner left would be far worse than showing no
   * name.
   *
   * Sent at all because the register's Owner field rendered `ownerId`, which answers "who is
   * accountable for this failure" with thirty-six characters that identify nobody. The SPA cannot
   * resolve it itself: `GET /v1/employees` needs `employee.read`, which a non-conformance reader is
   * not required to hold, and a page of rows cannot cost a request per row.
   */
  ownerName!: string | null;
  detectedAt!: string;
  raisedBy!: string;
  incidentId!: string | null;
  evidenceDocumentId!: string | null;
  containmentAction!: string | null;
  containedAt!: string | null;
  closedAt!: string | null;
  closureNote!: string | null;
  closedBy!: string | null;
  voidReason!: string | null;
  createdAt!: string;
}

export class NonconformanceRowResponseDto extends NonconformanceResponseDto {
  /** Resolved from `qms.nonconformance_severities` in the same query as the row. */
  severityRank!: number;
  requiresCapa!: boolean;
  containmentDueDays!: number;
  capaCount!: number;
  verifiedCapaCount!: number;
  /** `detectedAt + containmentDueDays`. Null once contained — a met deadline is not a deadline. */
  containmentDueOn!: string | null;
}

export class CapaResponseDto {
  id!: string;
  reference!: string;
  nonconformanceId!: string;
  status!: string;
  ownerId!: string;
  /**
   * The owner's display name, resolved server-side. Null once the employee row is gone; the CAPA and
   * its effectiveness evidence stay, so this is a left lookup and never a join.
   *
   * The CAPA card showed no owner AT ALL, which is worse than a uuid: `verify` and `ineffective` are
   * withheld from the owner by `CAPA_SELF_VERIFICATION`, so a reader looking at a card with no
   * sign-off button had nothing on screen explaining why.
   */
  ownerName!: string | null;
  rootCause!: string | null;
  rootCauseMethod!: string | null;
  actionPlan!: string | null;
  dueOn!: string | null;
  implementedAt!: string | null;
  verifiedAt!: string | null;
  verifiedBy!: string | null;
  effectivenessEvidence!: string | null;
  outcomeNote!: string | null;
  createdAt!: string;
}

export class CapaRowResponseDto extends CapaResponseDto {
  nonconformanceReference!: string;
  nonconformanceTitle!: string;
  nonconformanceSeverity!: string;
}

export class ContainmentOverdueResponseDto {
  id!: string;
  reference!: string;
  title!: string;
  severity!: string;
  severityRank!: number;
  processArea!: string;
  ownerId!: string;
  detectedAt!: string;
  dueOn!: string;
  daysOverdue!: number;
}

export class RecurrenceSignalResponseDto {
  processArea!: string;
  findings!: number;
  verifiedCapas!: number;
  /** The most recent finding raised AFTER a CAPA in that area was verified effective. */
  latestReference!: string;
  latestDetectedAt!: string;
  /** When the CAPA that should have prevented it was signed off. */
  earlierCapaVerifiedAt!: string;
}

// ── Internal audits ───────────────────────────────────────────────────────────

const auditStatus = z.enum(internalAuditStatusEnum.enumValues);
const auditRole = z.enum(auditRoleEnum.enumValues);

export const PlanAuditSchema = z.object({
  reference: reference('IA-2026-03'),
  title: z.string().min(5).max(200),
  /** What the audit sets out to establish. */
  objective: substantial,
  /** Which processes, sites and periods it covers — §9.2.2(b). */
  scope: substantial,
  /** The requirements audited AGAINST. A different question from scope. */
  criteria: z.string().min(5).max(2000),
  leadAuditorId: z.string().uuid(),
  plannedStartOn: z.string().date().nullable().optional(),
  plannedEndOn: z.string().date().nullable().optional(),
});
export class PlanAuditDto extends createZodDto(PlanAuditSchema) {}

/**
 * `status` and every state timestamp are absent DELIBERATELY — they belong to the lifecycle routes,
 * which check preconditions a patch would bypass. Reporting through a PATCH would skip the conclusion
 * and report-document requirement entirely.
 */
export const UpdateAuditSchema = PlanAuditSchema.omit({ reference: true })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Supply at least one field to update');
export class UpdateAuditDto extends createZodDto(UpdateAuditSchema) {}

export const StartAuditSchema = z.object({
  /** When fieldwork began. Defaults to now; supplied when writing up after the fact. */
  startedAt: z.string().datetime().optional(),
});
export class StartAuditDto extends createZodDto(StartAuditSchema) {}

export const ReportAuditSchema = z.object({
  /** What the audit concluded. Required by `ck_audit_reported_pair`. */
  conclusion: substantial,
  /** The audit report as a controlled document. Required — a report with no document is a chat. */
  reportDocumentId: z.string().uuid(),
});
export class ReportAuditDto extends createZodDto(ReportAuditSchema) {}

export const CancelAuditSchema = z.object({
  /** Why the audit did not happen. Required by `ck_audit_cancelled_pair`. */
  reason: substantial,
});
export class CancelAuditDto extends createZodDto(CancelAuditSchema) {}

export const AssignAuditorSchema = z.object({
  /**
   * `observer` is NOT an auditor for the impartiality rule — see `CapaService`. Assigning `lead`
   * makes this person the lead and moves the previous one to `auditor`.
   */
  role: auditRole.default('auditor'),
});
export class AssignAuditorDto extends createZodDto(AssignAuditorSchema) {}

export const ListAuditsQuerySchema = z
  .object({
    status: auditStatus.optional(),
    leadAuditorId: z.string().uuid().optional(),
    /** Anybody on the roster, in any role — "which audits was I on". */
    auditorId: z.string().uuid().optional(),
    /** Everything not closed or cancelled — the programme's live work. */
    openOnly: queryBoolean().optional(),
    plannedStartOnOrBefore: z.string().date().optional(),
    search: z.string().max(200).optional(),
  })
  .merge(PaginationQuerySchema);
export class ListAuditsQueryDto extends createZodDto(ListAuditsQuerySchema) {}

export class InternalAuditResponseDto {
  id!: string;
  reference!: string;
  title!: string;
  objective!: string;
  scope!: string;
  criteria!: string;
  status!: string;
  leadAuditorId!: string;
  /**
   * The lead auditor's display name, resolved server-side. Null when the employee row is gone — the
   * engagement record is §9.2.2(f) evidence and outlives the auditor who ran it, so this is a left
   * lookup and never a join.
   */
  leadAuditorName!: string | null;
  plannedStartOn!: string | null;
  plannedEndOn!: string | null;
  startedAt!: string | null;
  reportedAt!: string | null;
  conclusion!: string | null;
  reportDocumentId!: string | null;
  closedAt!: string | null;
  cancelReason!: string | null;
  createdAt!: string;
}

export class InternalAuditRowResponseDto extends InternalAuditResponseDto {
  /** People in `lead` or `auditor` roles. Observers are excluded — they did not audit. */
  auditorCount!: number;
  findingCount!: number;
  openFindingCount!: number;
}

export class AuditAuditorResponseDto {
  auditorId!: string;
  /**
   * Who audited, by name. Null when the employee row is gone; the roster row stays, because it is
   * what the impartiality rule reads and a leaver still audited this engagement. A left lookup, never
   * a join — a joined roster would silently shrink and quietly re-admit somebody to a review.
   *
   * The roster's whole job is to say who did the audit, and it rendered a column of uuids.
   */
  auditorName!: string | null;
  role!: string;
  addedBy!: string;
  createdAt!: string;
}

export class AuditFindingResponseDto {
  id!: string;
  reference!: string;
  title!: string;
  severity!: string;
  severityRank!: number;
  status!: string;
  ownerId!: string;
  detectedAt!: string;
}

export class UnlinkedFindingResponseDto {
  id!: string;
  reference!: string;
  title!: string;
  severity!: string;
  processArea!: string;
  detectedAt!: string;
  raisedBy!: string;
}

// ── Management reviews ────────────────────────────────────────────────────────

const reviewStatus = z.enum(managementReviewStatusEnum.enumValues);
const actionCategory = z.enum(managementReviewActionCategoryEnum.enumValues);
const actionStatus = z.enum(managementReviewActionStatusEnum.enumValues);

export const ScheduleReviewSchema = z.object({
  reference: reference('MR-2026-H1'),
  title: z.string().min(5).max(200),
  /** The period under review — "H1 2026". Free text; §9.3.1 leaves the interval to the organisation. */
  period: z.string().min(2).max(120),
  chairId: z.string().uuid(),
  scheduledFor: z.string().date().nullable().optional(),
});
export class ScheduleReviewDto extends createZodDto(ScheduleReviewSchema) {}

/**
 * `inputs` IS NOT HERE, and that is the point.
 *
 * The §9.3.2 snapshot is composed by the service when the review is held — see
 * `ManagementReviewService.hold`. A caller who could supply it could write minutes citing numbers
 * nothing measured, which is the one thing a frozen snapshot exists to prevent. Same rule as risk
 * scores and vendor review dates.
 */
export const UpdateReviewSchema = ScheduleReviewSchema.omit({ reference: true })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Supply at least one field to update');
export class UpdateReviewDto extends createZodDto(UpdateReviewSchema) {}

export const HoldReviewSchema = z.object({
  /** The date it was held. Defaults to today; supplied when minuting after the fact. */
  heldOn: z.string().date().optional(),
});
export class HoldReviewDto extends createZodDto(HoldReviewSchema) {}

export const CloseReviewSchema = z.object({
  /** What the review concluded. Required by `ck_mr_closed_pair`. */
  conclusion: substantial,
  /** The minutes as a controlled document — §9.3.3 wants documented outputs. */
  minutesDocumentId: z.string().uuid(),
});
export class CloseReviewDto extends createZodDto(CloseReviewSchema) {}

export const CancelReviewSchema = z.object({
  /** Why it did not happen. Required by `ck_mr_cancelled_pair`. */
  reason: substantial,
});
export class CancelReviewDto extends createZodDto(CancelReviewSchema) {}

export const RaiseReviewActionSchema = z.object({
  /** One of §9.3.3's three outputs. The clause is a closed list, so there is no `other`. */
  category: actionCategory,
  description: substantial,
  ownerId: z.string().uuid(),
  dueOn: z.string().date().nullable().optional(),
});
export class RaiseReviewActionDto extends createZodDto(RaiseReviewActionSchema) {}

export const UpdateReviewActionSchema = RaiseReviewActionSchema.partial().refine(
  (v) => Object.keys(v).length > 0,
  'Supply at least one field to update',
);
export class UpdateReviewActionDto extends createZodDto(UpdateReviewActionSchema) {}

export const ReviewActionOutcomeSchema = z.object({
  /** What was done, or why it was abandoned. Required by `ck_mr_action_outcome_note`. */
  outcomeNote: substantial,
});
export class ReviewActionOutcomeDto extends createZodDto(ReviewActionOutcomeSchema) {}

export const ListReviewsQuerySchema = z
  .object({
    status: reviewStatus.optional(),
    chairId: z.string().uuid().optional(),
    openOnly: queryBoolean().optional(),
    scheduledOnOrBefore: z.string().date().optional(),
    search: z.string().max(200).optional(),
  })
  .merge(PaginationQuerySchema);
export class ListReviewsQueryDto extends createZodDto(ListReviewsQuerySchema) {}

export const ListReviewActionsQuerySchema = z
  .object({
    status: actionStatus.optional(),
    category: actionCategory.optional(),
    ownerId: z.string().uuid().optional(),
    managementReviewId: z.string().uuid().optional(),
    /** Everything not completed or cancelled — the follow-up queue. */
    openOnly: queryBoolean().optional(),
    dueOnOrBefore: z.string().date().optional(),
  })
  .merge(PaginationQuerySchema);
export class ListReviewActionsQueryDto extends createZodDto(ListReviewActionsQuerySchema) {}

export class ManagementReviewResponseDto {
  id!: string;
  reference!: string;
  title!: string;
  period!: string;
  status!: string;
  chairId!: string;
  /**
   * The chair's display name, resolved server-side. Null when the employee row is gone — the minutes
   * of a held review are permanent and the person who chaired it may not be, so this is a left lookup
   * and never a join.
   */
  chairName!: string | null;
  scheduledFor!: string | null;
  heldOn!: string | null;
  /** The §9.3.2 inputs, frozen when the review was held. Null until then. Never settable. */
  inputs!: Record<string, unknown> | null;
  conclusion!: string | null;
  minutesDocumentId!: string | null;
  closedAt!: string | null;
  cancelReason!: string | null;
  createdAt!: string;
}

export class ManagementReviewRowResponseDto extends ManagementReviewResponseDto {
  actionCount!: number;
  openActionCount!: number;
}

export class ReviewActionResponseDto {
  id!: string;
  managementReviewId!: string;
  category!: string;
  description!: string;
  ownerId!: string;
  /**
   * Who is answerable for this output, by name. Null when the employee row is gone; the action is a
   * §9.3.3 output that the minutes already cite, so it is a left lookup and never a join.
   *
   * §9.3.2(a) makes the follow-up queue read "who is chasing this", and the action card showed no
   * owner at all — so the one question the queue exists to answer had no answer on screen.
   */
  ownerName!: string | null;
  dueOn!: string | null;
  status!: string;
  completedAt!: string | null;
  outcomeNote!: string | null;
  createdAt!: string;
}

export class ReviewActionRowResponseDto extends ReviewActionResponseDto {
  reviewReference!: string;
  reviewPeriod!: string;
}

export class CarriedForwardActionResponseDto {
  id!: string;
  reviewReference!: string;
  category!: string;
  description!: string;
  ownerId!: string;
  status!: string;
  dueOn!: string | null;
  /** Days past its due date, or null when it has none. */
  daysOverdue!: number | null;
}

/**
 * The assembled §9.3.2 inputs.
 *
 * COUNTS AND REFERENCES ONLY. The clause asks for information on performance and trends, which is an
 * aggregate — returning the registers' rows here would make this endpoint a way around their own
 * permissions.
 */
export class ReviewAgendaResponseDto {
  previousActions!: CarriedForwardActionResponseDto[];
  nonconformities!: {
    containmentOverdue: number;
    overdueReferences: string[];
    recurringProcessAreas: string[];
  };
  audits!: { findingsNotLinkedToAnAudit: number; unlinkedReferences: string[] };
  externalProviders!: {
    reviewGaps: number;
    gapReferences: string[];
    criticalWithoutRisk: number;
    unassessedSpendLines: number;
  };
  risks!: { untreated: number; untreatedReferences: string[] };
  assembledAt!: string;
}
