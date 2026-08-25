import { MS_PER_MIN, REPORT_ROW_LIMIT } from '@shared-kernel';
import { Inject, Injectable } from '@nestjs/common';
import {
  ConflictException,
  ErrorCodes,
  InjectDrizzle,
  NotFoundException,
  PreconditionFailedException,
  nameOf,
  resolveEmployeeNames,
  type DrizzleDB,
} from '@platform';
import type { Actor } from '@shared-kernel';
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE,
  AuditService,
  type ResourceAuditTrail,
} from '@modules/audit';
import {
  CAPA_REPOSITORY,
  NONCONFORMANCE_REPOSITORY,
  type ICapaRepository,
  type INonconformanceRepository,
} from '../domain/ports/qms.repository';
import { isSettledNonconformance } from '../infrastructure/persistence/nonconformance.drizzle-repository';
import type {
  ContainmentOverdue,
  Nonconformance,
  NonconformanceFilters,
  NonconformanceRow,
  NonconformanceSeverityLevel,
  NonconformanceStatus,
  RaiseNonconformanceInput,
  RecurrenceSignal,
  UpdateNonconformanceInput,
} from '../domain/qms.types';

/**
 * The finding lifecycle, declared rather than spread through `if` statements.
 *
 * The same shape as the incident and vendor modules, and for the same reason: the map IS the
 * specification, so a reviewer checks a table instead of tracing branches.
 *
 * `open → closed` IS NOT LEGAL, and that is enforced by `ck_nc_contained_states` as well as by this
 * map. ISO 9001 §10.2(a) requires reacting to the nonconformity — taking action to control and
 * correct it — so a finding that goes straight from "found" to "closed" with nothing recorded in
 * between is precisely the box-ticking the clause exists to prevent. Containment is cheap to record
 * and it is the evidence that somebody did something.
 *
 * The first draft of this map allowed it, on the reasoning that a minor finding could close on its
 * closure note alone. The database refused — the CHECK requiring `contained_at` for `closed` was
 * written first — and the CHECK was right.
 */
const ALLOWED_TRANSITIONS: Record<NonconformanceStatus, readonly NonconformanceStatus[]> = {
  open: ['contained', 'void'],
  contained: ['closed', 'void'],
  closed: [],
  void: [],
};

/**
 * Non-conformances: what was found, what was done about it, and whether it may be closed.
 *
 * WHAT THIS SERVICE OWNS THAT THE DATABASE CANNOT
 *
 * 1. THE CLOSURE GATE. A finding whose grade `requiresCapa` cannot be closed without a CAPA verified
 *    effective. That is a statement about rows in ANOTHER table, so no CHECK can hold it — and it is
 *    the rule the whole module exists for. Without it the register is a to-do list where anybody can
 *    tick the box.
 *
 * 2. THE GRADE IS READ FROM THE DATABASE. `requiresCapa` comes from
 *    `qms.nonconformance_severities`, never from a list in this file. Re-grading a finding from minor
 *    to major therefore tightens its closure requirement with no code change, which is what makes
 *    re-grading meaningful.
 *
 * 3. LEGALITY AND ATOMICITY. `ALLOWED_TRANSITIONS` plus a guarded `WHERE status = <from>`, so two
 *    people closing the same finding is Postgres's decision.
 *
 * 4. EVERY CHECK IS RESTATED AS A CODED REFUSAL, because a raw constraint violation reaches the
 *    caller as a 500 with no error code.
 *
 * 5. A SETTLED FINDING ACCEPTS NOTHING NEW — no edit, no re-grade, no further transition. The row
 *    stays because it and its CAPAs are the audit evidence.
 */
/**
 * How far ahead of the server's clock a client-supplied "when did this happen" may be.
 *
 * WHY A TOLERANCE AT ALL, on a rule whose whole point is that a thing cannot be detected in the
 * future. Because the timestamp is generated on the CALLER's clock and judged on the server's, and
 * those are never exactly equal: a browser on a laptop that has been asleep, a phone with no NTP, a
 * container whose clock steps after a host suspend. A strict `>` turns a one-millisecond skew into a
 * refusal the user cannot act on — they picked "now", and were told "now" is in the future.
 *
 * Measured, not hypothetical: the incidents browser journey (the same rule, one module over) sends `new Date().toISOString()` and
 * failed intermittently on exactly this, on a machine where the clock steps backwards after a
 * suspend. It read as a flaky test for weeks.
 *
 * Two minutes is chosen to be far larger than any plausible skew and far smaller than any meaningful
 * mistake. A user who picks tomorrow, or next week, is still refused — which is what the rule is for.
 */
const CLOCK_SKEW_TOLERANCE_MS = 2 * MS_PER_MIN;

@Injectable()
export class NonconformanceService {
  private readonly trail: ResourceAuditTrail;

  constructor(
    @Inject(NONCONFORMANCE_REPOSITORY) private readonly repo: INonconformanceRepository,
    @Inject(CAPA_REPOSITORY) private readonly capas: ICapaRepository,
    @InjectDrizzle() private readonly db: DrizzleDB,
    audit: AuditService,
  ) {
    // Resource type named ONCE — see `AuditService.forResource`.
    this.trail = audit.forResource(AUDIT_RESOURCE.NONCONFORMANCE);
  }

  // ── Severity grades ──────────────────────────────────────────────────────────

  /** The grades, their ranking, and the policy each carries. */
  async listSeverities(): Promise<NonconformanceSeverityLevel[]> {
    return this.repo.listSeverities();
  }

  // ── The register ─────────────────────────────────────────────────────────────

  /**
   * Raise a finding.
   *
   * Carries no permission at the route: anybody who notices a process failure must be able to record
   * it. `raisedBy` comes from the token, never from the payload.
   */
  async raise(input: RaiseNonconformanceInput, actor: Actor): Promise<Nonconformance> {
    if (await this.repo.findByReference(input.reference)) {
      throw new ConflictException(
        ErrorCodes.CONFLICT,
        `Non-conformance reference '${input.reference}' already exists`,
      );
    }
    this.assertNotFutureDetection(input.detectedAt);

    return this.db.transaction(async (tx) => {
      const finding = await this.repo.create({ ...input, raisedBy: actor.sub }, tx);
      await this.trail.record(AUDIT_ACTION.NONCONFORMANCE_RAISED, finding.id, actor, tx, {
        after: {
          reference: finding.reference,
          severity: finding.severity,
          source: finding.source,
          processArea: finding.processArea,
          ownerId: finding.ownerId,
        },
      });
      return finding;
    });
  }

  async getById(id: string): Promise<Nonconformance> {
    const finding = await this.repo.findById(id);
    if (!finding) {
      throw new NotFoundException(ErrorCodes.NOT_FOUND, `Non-conformance ${id} not found`);
    }
    return finding;
  }

  /**
   * One finding as the register sees it — grade rules, CAPA counts and the owner's NAME included.
   *
   * The read path for a detail view. Transitions keep using `getById`: they need the row they are about to
   * guard, not the counts, and reading the heavier projection there would compute two subqueries per move.
   * The owner lookup rides here for the same reason — contain, close and void render nobody, so widening
   * `getById` would have added a directory read to every transition to serve one drawer.
   */
  async getRowById(id: string): Promise<NonconformanceRow & { ownerName: string | null }> {
    const row = await this.repo.findRowById(id);
    if (!row) {
      throw new NotFoundException(ErrorCodes.NOT_FOUND, `Non-conformance ${id} not found`);
    }
    const names = await resolveEmployeeNames(this.db, [row.ownerId]);
    return { ...row, ownerName: nameOf(names, row.ownerId) };
  }

  async list(filters: NonconformanceFilters, limit: number, offset: number) {
    const page = await this.repo.list(filters, limit, offset);
    /*
     * OWNER NAMES for the whole page, in one query.
     *
     * The register's Owner field rendered `ownerId` — thirty-six characters answering "who is
     * accountable for this failure" with nothing, and worse than nothing on uuid v7, where findings
     * raised the same afternoon share a time prefix and look alike. Resolved here rather than in the
     * SPA because the directory endpoint needs `employee.read`, which a non-conformance reader is not
     * required to hold.
     */
    const names = await resolveEmployeeNames(
      this.db,
      page.rows.map((r) => r.ownerId),
    );
    return {
      ...page,
      rows: page.rows.map((r) => ({ ...r, ownerName: nameOf(names, r.ownerId) })),
    };
  }

  async update(
    id: string,
    input: UpdateNonconformanceInput,
    actor: Actor,
  ): Promise<Nonconformance> {
    const before = await this.getById(id);
    this.assertNotSettled(before);
    this.assertNotFutureDetection(input.detectedAt);

    return this.db.transaction(async (tx) => {
      const after = await this.repo.update(id, input, tx);
      await this.trail.record(AUDIT_ACTION.NONCONFORMANCE_UPDATED, id, actor, tx, {
        before: {
          severity: before.severity,
          ownerId: before.ownerId,
          processArea: before.processArea,
        },
        after: {
          severity: after!.severity,
          ownerId: after!.ownerId,
          processArea: after!.processArea,
        },
      });
      return after!;
    });
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  /** Record the immediate fix. `ck_nc_contained_pair` demands the action, so it is required here. */
  async contain(
    id: string,
    containmentAction: string,
    containedAt: string | undefined,
    actor: Actor,
  ): Promise<Nonconformance> {
    const finding = await this.getById(id);
    this.assertTransitionAllowed(finding, 'contained');

    const at = containedAt ? new Date(containedAt) : new Date();
    this.assertNotBefore(at, finding.detectedAt, 'Containment');

    return this.move(
      finding,
      'contained',
      { containmentAction, containedAt: at },
      AUDIT_ACTION.NONCONFORMANCE_CONTAINED,
      actor,
      {},
    );
  }

  /**
   * Close a finding.
   *
   * THE GATE. A grade that `requiresCapa` needs a CAPA verified effective first — read from the
   * severity table and from the CAPA rows, not from anything in this file.
   */
  async close(id: string, closureNote: string, actor: Actor): Promise<Nonconformance> {
    const finding = await this.getById(id);
    this.assertTransitionAllowed(finding, 'closed');

    const grade = await this.severityFor(finding.severity);
    if (grade.requiresCapa) {
      const verified = await this.capas.hasVerifiedCapa(id);
      if (!verified) {
        throw new PreconditionFailedException(
          ErrorCodes.NONCONFORMANCE_CAPA_REQUIRED,
          `${finding.reference} is graded '${finding.severity}', which cannot be closed until a ` +
            'corrective action has been verified effective — ISO 9001 §10.2(d)',
        );
      }
    }

    return this.move(
      finding,
      'closed',
      { closedAt: new Date(), closureNote, closedBy: actor.sub },
      AUDIT_ACTION.NONCONFORMANCE_CLOSED,
      actor,
      { requiredCapa: grade.requiresCapa },
    );
  }

  /**
   * Mark a finding as raised in error.
   *
   * Kept rather than deleted: "we looked and there was nothing wrong" is a record an auditor may ask
   * about, and a register that quietly loses rows cannot be reconciled against an audit report.
   */
  async void(id: string, reason: string, actor: Actor): Promise<Nonconformance> {
    const finding = await this.getById(id);
    this.assertTransitionAllowed(finding, 'void');

    // `ck_nc_void_clean` refuses a void that carries containment. Restated, because a caller who has
    // already contained something is telling us it WAS a real finding.
    if (finding.containedAt) {
      throw new PreconditionFailedException(
        ErrorCodes.NONCONFORMANCE_NOT_IN_STATE,
        `${finding.reference} has a recorded containment action, so it cannot be voided as raised ` +
          'in error — close it instead',
      );
    }

    return this.move(
      finding,
      'void',
      { voidReason: reason },
      AUDIT_ACTION.NONCONFORMANCE_VOIDED,
      actor,
      { reason },
    );
  }

  // ── Reports ──────────────────────────────────────────────────────────────────

  /** Findings past the containment deadline their grade allows. */
  async containmentOverdue(limit = REPORT_ROW_LIMIT): Promise<ContainmentOverdue[]> {
    return this.repo.containmentOverdue(limit);
  }

  /** Process areas where findings recur despite a CAPA already verified effective. */
  async recurrenceSignals(limit = REPORT_ROW_LIMIT): Promise<RecurrenceSignal[]> {
    return this.repo.recurrenceSignals(limit);
  }

  // ── Shared internals ─────────────────────────────────────────────────────────

  /**
   * One transition, applied and audited.
   *
   * Every lifecycle method funnels through here, so the guarded update, the lost-race refusal and the
   * audit entry are written once.
   */
  private async move(
    finding: Nonconformance,
    to: NonconformanceStatus,
    extra: Parameters<INonconformanceRepository['transition']>[3],
    action: (typeof AUDIT_ACTION)[keyof typeof AUDIT_ACTION],
    actor: Actor,
    metadata: Record<string, unknown>,
  ): Promise<Nonconformance> {
    const from = finding.status;

    return this.db.transaction(async (tx) => {
      const moved = await this.repo.transition(finding.id, from, to, extra, tx);
      if (!moved) {
        // The guarded WHERE found nothing, so somebody else moved it first. Refusing is right: the
        // gate above was evaluated against a state that no longer holds.
        throw new ConflictException(
          ErrorCodes.NONCONFORMANCE_NOT_IN_STATE,
          `${finding.reference} was no longer '${from}' — read it again and retry`,
        );
      }
      await this.trail.record(action, finding.id, actor, tx, {
        before: { status: from },
        after: { status: to, ...metadata },
      });
      return moved;
    });
  }

  /** `ALLOWED_TRANSITIONS` as a coded refusal. */
  private assertTransitionAllowed(finding: Nonconformance, to: NonconformanceStatus): void {
    if (!ALLOWED_TRANSITIONS[finding.status].includes(to)) {
      const legal = ALLOWED_TRANSITIONS[finding.status];
      throw new PreconditionFailedException(
        ErrorCodes.NONCONFORMANCE_NOT_IN_STATE,
        `${finding.reference} is '${finding.status}', which cannot become '${to}'. ` +
          (legal.length === 0
            ? 'That status is terminal.'
            : `Legal next states: ${legal.join(', ')}.`),
      );
    }
  }

  private assertNotSettled(finding: Nonconformance): void {
    if (isSettledNonconformance(finding.status)) {
      throw new PreconditionFailedException(
        ErrorCodes.NONCONFORMANCE_SETTLED,
        `${finding.reference} is '${finding.status}' and accepts no further changes`,
      );
    }
  }

  /** A finding cannot have been detected in the future. `detected_at` anchors every deadline. */
  private assertNotFutureDetection(detectedAt: string | undefined): void {
    if (detectedAt && new Date(detectedAt).getTime() > Date.now() + CLOCK_SKEW_TOLERANCE_MS) {
      throw new PreconditionFailedException(
        ErrorCodes.NONCONFORMANCE_NOT_IN_STATE,
        'A finding cannot be detected in the future — every containment deadline counts from that date',
      );
    }
  }

  /** `ck_nc_timeline_order` in words, so a backdated containment is a code and not a 500. */
  private assertNotBefore(at: Date, floor: Date, what: string): void {
    if (at.getTime() < floor.getTime()) {
      throw new PreconditionFailedException(
        ErrorCodes.NONCONFORMANCE_NOT_IN_STATE,
        `${what} cannot predate detection (${floor.toISOString()})`,
      );
    }
  }

  /**
   * The grade row, read from the database.
   *
   * Not cached and not hard-coded. Four rows, so a read per closure is not the cost worth optimising,
   * and a stale copy of `requiresCapa` is exactly what would let a major finding close on nothing.
   */
  private async severityFor(
    severity: Nonconformance['severity'],
  ): Promise<NonconformanceSeverityLevel> {
    const grades = await this.repo.listSeverities();
    const grade = grades.find((g) => g.code === severity);
    if (!grade) {
      // Unreachable through the FK, which is the point of the FK. Refusing loudly beats assuming a
      // CAPA is not required.
      throw new PreconditionFailedException(
        ErrorCodes.NONCONFORMANCE_NOT_IN_STATE,
        `No severity grade '${severity}' is defined, so the closure requirement cannot be determined`,
      );
    }
    return grade;
  }
}

export { ALLOWED_TRANSITIONS as NONCONFORMANCE_TRANSITIONS };
