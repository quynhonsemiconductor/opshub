import { REPORT_ROW_LIMIT } from '@shared-kernel';
import { Inject, Injectable } from '@nestjs/common';
import {
  ConflictException,
  ErrorCodes,
  InjectDrizzle,
  NotFoundException,
  PreconditionFailedException,
  assertDateOrder,
  nameOf,
  resolveEmployeeNames,
  type DrizzleDB,
} from '@platform';
import type { Actor } from '@shared-kernel';
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE,
  AuditService,
  type AuditAction,
  type ResourceAuditTrail,
} from '@modules/audit';
import {
  INTERNAL_AUDIT_REPOSITORY,
  type IInternalAuditRepository,
} from '../domain/ports/qms.repository';
import { isSettledAudit } from '../infrastructure/persistence/internal-audit.drizzle-repository';
import type {
  AuditFinding,
  AuditRole,
  InternalAudit,
  InternalAuditAuditor,
  InternalAuditFilters,
  InternalAuditStatus,
  PlanAuditInput,
  UnlinkedFinding,
  UpdateAuditInput,
} from '../domain/internal-audit.types';

/**
 * The audit lifecycle, declared rather than spread through `if` statements.
 *
 * `in_progress → closed` IS NOT LEGAL, and the database says so too
 * (`ck_audit_reported_pair` requires the conclusion and the report for `closed`). ISO 9001 §9.2.2(d)
 * makes reporting results to relevant management its own obligation: an audit whose fieldwork
 * finished and whose results never reached anybody has not been done, whatever the status column
 * says. So closing goes through `reported`, always.
 *
 * `cancelled` is reachable from `planned` and `in_progress` but not from `reported`: once results
 * have been reported, the audit happened, and the record of it is not cancellable.
 */
const ALLOWED_TRANSITIONS: Record<InternalAuditStatus, readonly InternalAuditStatus[]> = {
  planned: ['in_progress', 'cancelled'],
  in_progress: ['reported', 'cancelled'],
  reported: ['closed'],
  closed: [],
  cancelled: [],
};

/**
 * Internal audits — the programme, the roster, and the findings each engagement raised.
 *
 * WHAT THIS SERVICE OWNS THAT THE DATABASE CANNOT
 *
 * 1. FIELDWORK NEEDS AUDITORS. An audit cannot start with nobody rostered to do it — a count over
 *    another table, so no CHECK can hold it. The lead is written onto the roster when the audit is
 *    planned, so this refuses only when somebody has removed everybody.
 *
 * 2. THE LEAD IS ON THE ROSTER, ALWAYS. `lead_auditor_id` and the `lead` roster row are written in
 *    one transaction, and changing the lead moves the roster row with it. Two places holding the
 *    same fact is the arrangement the schema chose (the column is what the register reads, the
 *    roster is what the impartiality rule reads), so keeping them in step is this service's job and
 *    is done in one method rather than at each call site.
 *
 * 3. IMPARTIALITY IS ENFORCED IN `CapaService`, NOT HERE. The rule is "somebody who audited a
 *    finding may not certify that the fix worked", which is a statement spanning the roster, the
 *    finding and the CAPA. It lives at the point of the decision it constrains — the verification —
 *    because a rule enforced anywhere else is a rule the verification can be reached without.
 *
 * 4. A SETTLED AUDIT ACCEPTS NOTHING NEW — no edit, no roster change, no further transition. The
 *    row and its findings are the §9.2.2(f) evidence.
 */
@Injectable()
export class InternalAuditService {
  private readonly trail: ResourceAuditTrail;

  constructor(
    @Inject(INTERNAL_AUDIT_REPOSITORY) private readonly repo: IInternalAuditRepository,
    @InjectDrizzle() private readonly db: DrizzleDB,
    audit: AuditService,
  ) {
    this.trail = audit.forResource(AUDIT_RESOURCE.INTERNAL_AUDIT);
  }

  // ── The programme ────────────────────────────────────────────────────────────

  async plan(input: PlanAuditInput, actor: Actor): Promise<InternalAudit> {
    if (await this.repo.findByReference(input.reference)) {
      throw new ConflictException(
        ErrorCodes.CONFLICT,
        `Internal audit reference '${input.reference}' already exists`,
      );
    }
    this.assertPlannedWindow(input.plannedStartOn, input.plannedEndOn);

    return this.db.transaction(async (tx) => {
      const created = await this.repo.create(input, tx);
      // Invariant 2: the lead is on the roster from the moment the audit exists, so `didAudit` is
      // true for them without anybody having to remember a second call.
      await this.repo.upsertAuditor(created.id, input.leadAuditorId, 'lead', actor.sub, tx);
      await this.trail.record(AUDIT_ACTION.INTERNAL_AUDIT_PLANNED, created.id, actor, tx, {
        after: {
          reference: created.reference,
          title: created.title,
          leadAuditorId: created.leadAuditorId,
          plannedStartOn: created.plannedStartOn,
        },
      });
      return created;
    });
  }

  async getById(id: string): Promise<InternalAudit> {
    const audit = await this.repo.findById(id);
    if (!audit) {
      throw new NotFoundException(ErrorCodes.NOT_FOUND, `Internal audit ${id} not found`);
    }
    return audit;
  }

  /**
   * One audit with its lead auditor named — the single-record read path.
   *
   * Separate from `getById` rather than folded into it, because that one is the guard nine write paths
   * call first (update, start, report, close, cancel, and both roster changes) and none of them render
   * a lead. Widening it would have added a directory query to every one of them to serve one drawer.
   */
  async getWithLeadAuditor(
    id: string,
  ): Promise<InternalAudit & { leadAuditorName: string | null }> {
    const audit = await this.getById(id);
    const names = await resolveEmployeeNames(this.db, [audit.leadAuditorId]);
    return { ...audit, leadAuditorName: nameOf(names, audit.leadAuditorId) };
  }

  async list(filters: InternalAuditFilters, limit: number, offset: number) {
    const page = await this.repo.list(filters, limit, offset);
    /*
     * LEAD AUDITOR NAMES for the whole page, in one query.
     *
     * The programme's drawer reads its subject out of this list rather than re-fetching it, so this is
     * the resolution the screen actually renders. Server-side because `GET /v1/employees` needs
     * `employee.read`, which `internal_audit.read` does not imply.
     */
    const names = await resolveEmployeeNames(
      this.db,
      page.rows.map((r) => r.leadAuditorId),
    );
    return {
      ...page,
      rows: page.rows.map((r) => ({ ...r, leadAuditorName: nameOf(names, r.leadAuditorId) })),
    };
  }

  async update(id: string, input: UpdateAuditInput, actor: Actor): Promise<InternalAudit> {
    const before = await this.getById(id);
    this.assertNotSettled(before);

    // Validated against the row AS IT WILL BE: a patch moving one end of the window still has to
    // agree with the end already stored.
    this.assertPlannedWindow(
      input.plannedStartOn === undefined ? before.plannedStartOn : input.plannedStartOn,
      input.plannedEndOn === undefined ? before.plannedEndOn : input.plannedEndOn,
    );

    return this.db.transaction(async (tx) => {
      const after = await this.repo.update(id, input, tx);
      // Invariant 2: a new lead joins the roster as `lead`. The previous lead STAYS on the roster as
      // an auditor unless somebody removes them — they may well have done fieldwork, and dropping
      // them silently would erase that from the impartiality rule's view.
      if (input.leadAuditorId && input.leadAuditorId !== before.leadAuditorId) {
        await this.repo.upsertAuditor(id, input.leadAuditorId, 'lead', actor.sub, tx);
        await this.repo.upsertAuditor(id, before.leadAuditorId, 'auditor', actor.sub, tx);
      }
      await this.trail.record(AUDIT_ACTION.INTERNAL_AUDIT_UPDATED, id, actor, tx, {
        before: { title: before.title, leadAuditorId: before.leadAuditorId },
        after: { title: after!.title, leadAuditorId: after!.leadAuditorId },
      });
      return after!;
    });
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  /** Begin fieldwork. Refuses when nobody is rostered to do it. */
  async start(id: string, startedAt: string | undefined, actor: Actor): Promise<InternalAudit> {
    const audit = await this.getById(id);
    this.assertTransitionAllowed(audit, 'in_progress');

    const auditors = await this.repo.listAuditors(id);
    const auditing = auditors.filter((a) => a.role !== 'observer');
    if (auditing.length === 0) {
      throw new PreconditionFailedException(
        ErrorCodes.INTERNAL_AUDIT_NO_AUDITORS,
        `${audit.reference} has nobody rostered as lead or auditor, so fieldwork cannot start`,
      );
    }

    return this.move(
      audit,
      'in_progress',
      { startedAt: startedAt ? new Date(startedAt) : new Date() },
      AUDIT_ACTION.INTERNAL_AUDIT_STARTED,
      actor,
      { auditors: auditing.length },
    );
  }

  /**
   * Report the results to management — §9.2.2(d).
   *
   * The conclusion and the report document are both required, by the CHECK and restated here. An
   * audit report with no conclusion is a pile of findings; one with no document is a conversation.
   */
  async report(
    id: string,
    conclusion: string,
    reportDocumentId: string,
    actor: Actor,
  ): Promise<InternalAudit> {
    const audit = await this.getById(id);
    this.assertTransitionAllowed(audit, 'reported');

    const at = new Date();
    if (audit.startedAt && at.getTime() < audit.startedAt.getTime()) {
      // `ck_audit_timeline_order` restated. Unreachable while the timestamp is `now()`, kept for the
      // day this method accepts a supplied date.
      throw new PreconditionFailedException(
        ErrorCodes.INTERNAL_AUDIT_NOT_IN_STATE,
        'An audit cannot be reported before it started',
      );
    }

    return this.move(
      audit,
      'reported',
      { reportedAt: at, conclusion, reportDocumentId },
      AUDIT_ACTION.INTERNAL_AUDIT_REPORTED,
      actor,
      { reportDocumentId },
    );
  }

  /**
   * Close the engagement.
   *
   * Deliberately does NOT require the findings to be closed. §9.2.2(e) asks for action without undue
   * delay, and the CAPA machinery tracks that per finding with its own gate — an audit held open
   * until every corrective action is verified would stay open for months and stop meaning anything.
   * The open-finding count on the register row is how a reader sees what is outstanding.
   */
  async close(id: string, actor: Actor): Promise<InternalAudit> {
    const audit = await this.getById(id);
    this.assertTransitionAllowed(audit, 'closed');
    return this.move(
      audit,
      'closed',
      { closedAt: new Date() },
      AUDIT_ACTION.INTERNAL_AUDIT_CLOSED,
      actor,
      {},
    );
  }

  /** Record an audit that did not happen, and why. */
  async cancel(id: string, reason: string, actor: Actor): Promise<InternalAudit> {
    const audit = await this.getById(id);
    this.assertTransitionAllowed(audit, 'cancelled');
    return this.move(
      audit,
      'cancelled',
      { cancelReason: reason },
      AUDIT_ACTION.INTERNAL_AUDIT_CANCELLED,
      actor,
      { reason },
    );
  }

  // ── The roster ───────────────────────────────────────────────────────────────

  async assignAuditor(id: string, auditorId: string, role: AuditRole, actor: Actor): Promise<void> {
    const audit = await this.getById(id);
    this.assertNotSettled(audit);

    await this.db.transaction(async (tx) => {
      await this.repo.upsertAuditor(id, auditorId, role, actor.sub, tx);
      // Invariant 2 in the other direction: rostering somebody as `lead` makes them the lead.
      // Without this the column and the roster would disagree, and the register would name one
      // person while the impartiality rule read another.
      if (role === 'lead' && auditorId !== audit.leadAuditorId) {
        await this.repo.update(id, { leadAuditorId: auditorId }, tx);
        await this.repo.upsertAuditor(id, audit.leadAuditorId, 'auditor', actor.sub, tx);
      }
      await this.trail.record(AUDIT_ACTION.INTERNAL_AUDIT_AUDITOR_ASSIGNED, id, actor, tx, {
        after: { auditorId, role },
      });
    });
  }

  async removeAuditor(id: string, auditorId: string, actor: Actor): Promise<void> {
    const audit = await this.getById(id);
    this.assertNotSettled(audit);

    // The lead cannot be removed, only replaced: `lead_auditor_id` is NOT NULL, so removing the
    // roster row would leave the column pointing at somebody who is not on the audit.
    if (auditorId === audit.leadAuditorId) {
      throw new PreconditionFailedException(
        ErrorCodes.INTERNAL_AUDIT_LEAD_REQUIRED,
        `${audit.reference} cannot lose its lead auditor — assign a different lead instead, which ` +
          'moves this one to `auditor`',
      );
    }

    await this.db.transaction(async (tx) => {
      const removed = await this.repo.removeAuditor(id, auditorId, tx);
      if (!removed) {
        throw new NotFoundException(ErrorCodes.NOT_FOUND, 'That person is not on this audit');
      }
      await this.trail.record(AUDIT_ACTION.INTERNAL_AUDIT_AUDITOR_REMOVED, id, actor, tx, {
        before: { auditorId },
      });
    });
  }

  /**
   * The roster, with each person named.
   *
   * The roster's whole job is to say WHO audited this engagement — it is what the §9.2.2(c)
   * impartiality rule reads, and adding somebody to it takes a decision away from them later. It
   * rendered a column of uuids, so the one screen where knowing the person matters most named nobody.
   *
   * One query for the whole roster, and the names are keyed on `auditorId` — NOT on `addedBy`, which
   * is the other employee column on the same row and would give every entry the same name.
   */
  async listAuditors(
    id: string,
  ): Promise<(InternalAuditAuditor & { auditorName: string | null })[]> {
    await this.getById(id);
    const rows = await this.repo.listAuditors(id);
    const names = await resolveEmployeeNames(
      this.db,
      rows.map((r) => r.auditorId),
    );
    return rows.map((r) => ({ ...r, auditorName: nameOf(names, r.auditorId) }));
  }

  // ── Findings ─────────────────────────────────────────────────────────────────

  async listFindings(id: string): Promise<AuditFinding[]> {
    await this.getById(id);
    return this.repo.listFindings(id);
  }

  /** `internal_audit` findings that name no audit — the traceability gap. */
  async unlinkedFindings(limit = REPORT_ROW_LIMIT): Promise<UnlinkedFinding[]> {
    return this.repo.unlinkedFindings(limit);
  }

  // ── Shared internals ─────────────────────────────────────────────────────────

  private async move(
    audit: InternalAudit,
    to: InternalAuditStatus,
    extra: Parameters<IInternalAuditRepository['transition']>[3],
    action: AuditAction,
    actor: Actor,
    metadata: Record<string, unknown>,
  ): Promise<InternalAudit> {
    const from = audit.status;

    return this.db.transaction(async (tx) => {
      const moved = await this.repo.transition(audit.id, from, to, extra, tx);
      if (!moved) {
        throw new ConflictException(
          ErrorCodes.INTERNAL_AUDIT_NOT_IN_STATE,
          `${audit.reference} was no longer '${from}' — read it again and retry`,
        );
      }
      await this.trail.record(action, audit.id, actor, tx, {
        before: { status: from },
        after: { status: to, ...metadata },
      });
      return moved;
    });
  }

  private assertTransitionAllowed(audit: InternalAudit, to: InternalAuditStatus): void {
    if (!ALLOWED_TRANSITIONS[audit.status].includes(to)) {
      const legal = ALLOWED_TRANSITIONS[audit.status];
      throw new PreconditionFailedException(
        ErrorCodes.INTERNAL_AUDIT_NOT_IN_STATE,
        `${audit.reference} is '${audit.status}', which cannot become '${to}'. ` +
          (legal.length === 0
            ? 'That status is terminal.'
            : `Legal next states: ${legal.join(', ')}.`),
      );
    }
  }

  private assertNotSettled(audit: InternalAudit): void {
    if (isSettledAudit(audit.status)) {
      throw new PreconditionFailedException(
        ErrorCodes.INTERNAL_AUDIT_SETTLED,
        `${audit.reference} is '${audit.status}' and accepts no further changes`,
      );
    }
  }

  /** `ck_audit_planned_window`, via the guard shared with contracts, positions and vendors. */
  private assertPlannedWindow(
    from: string | null | undefined,
    to: string | null | undefined,
  ): void {
    if (from && to) {
      assertDateOrder(from, to, ErrorCodes.INTERNAL_AUDIT_INVALID_WINDOW, 'Planned audit window');
    }
  }
}

export { ALLOWED_TRANSITIONS as INTERNAL_AUDIT_TRANSITIONS };
