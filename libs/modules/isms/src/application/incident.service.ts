import { Inject, Injectable } from '@nestjs/common';
import {
  ConflictException,
  ErrorCodes,
  InjectDrizzle,
  NotFoundException,
  PreconditionFailedException,
  type DrizzleDB,
} from '@platform';
import { MS_PER_MIN, REPORT_ROW_LIMIT, type Actor } from '@shared-kernel';
import {
  AUDIT_ACTION,
  type AuditAction,
  AUDIT_RESOURCE,
  AuditService,
  type ResourceAuditTrail,
} from '@modules/audit';
import { INCIDENT_REPOSITORY, type IIncidentRepository } from '../domain/ports/incident.repository';
import { isTerminalIncidentStatus } from '../infrastructure/persistence/incident.drizzle-repository';
import type {
  Incident,
  IncidentEvent,
  IncidentFilters,
  IncidentStatus,
  OverdueBreach,
  RecordEventInput,
  ReportIncidentInput,
  UpdateIncidentInput,
} from '../domain/incident.types';

/** GDPR Article 33: 72 hours from becoming aware. The one number the breach report turns on. */
export const BREACH_NOTIFICATION_HOURS = 72;

/**
 * Which statuses a given status may move to.
 *
 * Declared as a map rather than checked with `if` chains, because the legal moves ARE the model: a
 * reader should be able to see the whole state machine without tracing branches, and a new state is
 * one entry rather than an edit in five places.
 *
 * `false_positive` is reachable early and from nowhere late: once something has been contained it
 * demonstrably was an incident, so calling it a false positive afterwards would contradict the
 * containment timestamp — which `ck_incident_false_positive` also refuses.
 */
const ALLOWED_TRANSITIONS: Record<IncidentStatus, readonly IncidentStatus[]> = {
  reported: ['triaged', 'false_positive'],
  triaged: ['contained', 'false_positive'],
  contained: ['resolved'],
  resolved: ['closed'],
  closed: [],
  false_positive: [],
};

/**
 * Security incidents: reporting, handling, the append-only timeline, and the breach clock.
 *
 * WHAT THIS SERVICE OWNS THAT THE DATABASE CANNOT
 *
 * 1. THE STATE MACHINE. The CHECKs describe a valid ROW — a `resolved` incident has a
 *    `resolved_at` and a root cause. They cannot say that `reported` may not jump straight to
 *    `closed`, because a CHECK cannot see the previous value. `ALLOWED_TRANSITIONS` is that rule,
 *    and every move is ALSO a guarded `WHERE status = <from>` in the repository, so two responders
 *    working the same incident — the normal case, not the edge case — race in Postgres rather than
 *    in the service.
 *
 * 2. THE TIMELINE IS WRITTEN BY THE TRANSITION, not by the caller remembering to. Every status
 *    change appends a `status_change` entry in the SAME transaction, so a timeline can never be
 *    missing the step the status column claims happened.
 *
 * 3. TRANSLATING CONSTRAINTS INTO ANSWERS. Each CHECK — and each foreign key — is restated as a
 *    coded refusal in front of the write, because a raw violation reaches the caller as a 500 with
 *    no error code and no indication of which field was wrong.
 *
 * REPORTING NEEDS NO PERMISSION. Anybody who notices something must be able to raise it; handling
 * is what `incident.manage` governs. That asymmetry is deliberate and is enforced at the routes.
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
 * Measured, not hypothetical: the incidents browser journey sends `new Date().toISOString()` and
 * failed intermittently on exactly this, on a machine where the clock steps backwards after a
 * suspend. It read as a flaky test for weeks.
 *
 * Two minutes is chosen to be far larger than any plausible skew and far smaller than any meaningful
 * mistake. A user who picks tomorrow, or next week, is still refused — which is what the rule is for.
 */
const CLOCK_SKEW_TOLERANCE_MS = 2 * MS_PER_MIN;

@Injectable()
export class IncidentService {
  private readonly trail: ResourceAuditTrail;

  constructor(
    @Inject(INCIDENT_REPOSITORY) private readonly repo: IIncidentRepository,
    @InjectDrizzle() private readonly db: DrizzleDB,
    private readonly audit: AuditService,
  ) {
    // Resource type named ONCE — see `AuditService.forResource`.
    this.trail = audit.forResource(AUDIT_RESOURCE.INCIDENT);
  }

  // ── Reads ────────────────────────────────────────────────────────────────────

  async getIncident(id: string): Promise<Incident> {
    const incident = await this.repo.findById(id);
    if (!incident) throw new NotFoundException(ErrorCodes.NOT_FOUND, `Incident ${id} not found`);
    return incident;
  }

  async listIncidents(filters: IncidentFilters, limit: number, offset: number) {
    return this.repo.list(filters, limit, offset);
  }

  async listTimeline(incidentId: string): Promise<IncidentEvent[]> {
    await this.getIncident(incidentId);
    return this.repo.listEvents(incidentId);
  }

  // ── Reporting ────────────────────────────────────────────────────────────────

  /**
   * Raise an incident. Needs no permission — see the class comment.
   *
   * The first timeline entry is written here, in the same transaction, so a timeline always starts
   * with the report rather than with whatever the first responder happened to note.
   */
  async reportIncident(input: ReportIncidentInput, actor: Actor): Promise<Incident> {
    if (await this.repo.findByReference(input.reference)) {
      throw new ConflictException(
        ErrorCodes.CONFLICT,
        `Incident reference '${input.reference}' is already in use`,
      );
    }
    if (new Date(input.detectedAt).getTime() > Date.now() + CLOCK_SKEW_TOLERANCE_MS) {
      throw new PreconditionFailedException(
        ErrorCodes.INCIDENT_TIMELINE_ORDER,
        'An incident cannot be detected in the future',
      );
    }

    return this.db.transaction(async (tx) => {
      const incident = await this.repo.create({ ...input, reportedBy: actor.sub }, tx);
      await this.repo.appendEvent(
        incident.id,
        {
          type: 'status_change',
          detail: `Reported as ${incident.severity} severity`,
          recordedBy: actor.sub,
          occurredAt: incident.detectedAt,
        },
        tx,
      );
      await this.trail.record(AUDIT_ACTION.INCIDENT_REPORTED, incident.id, actor, tx, {
        after: {
          reference: incident.reference,
          severity: incident.severity,
          personalDataBreach: incident.personalDataBreach,
        },
      });
      return incident;
    });
  }

  /** Correct the details while handling continues. Refused once the incident is finished. */
  async updateIncident(id: string, input: UpdateIncidentInput, actor: Actor): Promise<Incident> {
    const before = await this.getIncident(id);
    this.assertOpen(before);
    this.assertBreachNotRetracted(before, input);

    if (input.detectedAt) {
      const detected = new Date(input.detectedAt);
      if (detected.getTime() > Date.now() + CLOCK_SKEW_TOLERANCE_MS) {
        throw new PreconditionFailedException(
          ErrorCodes.INCIDENT_TIMELINE_ORDER,
          'An incident cannot be detected in the future',
        );
      }
      // `ck_incident_timeline_order` compares against the handling timestamps already recorded, so
      // moving detection forward past them would arrive as a 500 with no code.
      for (const [label, stamp] of [
        ['contained', before.containedAt],
        ['resolved', before.resolvedAt],
      ] as const) {
        if (stamp && detected.getTime() > stamp.getTime()) {
          throw new PreconditionFailedException(
            ErrorCodes.INCIDENT_TIMELINE_ORDER,
            `Detection cannot be moved after the incident was ${label}`,
          );
        }
      }
    }

    await this.assertReferencesResolve(before, input);

    return this.db.transaction(async (tx) => {
      const after = await this.repo.update(id, input, tx);
      await this.trail.record(AUDIT_ACTION.INCIDENT_UPDATED, id, actor, tx, {
        before: { severity: before.severity, personalDataBreach: before.personalDataBreach },
        after: { severity: after!.severity, personalDataBreach: after!.personalDataBreach },
      });
      return after!;
    });
  }

  // ── Handling ─────────────────────────────────────────────────────────────────

  /** `reported` → `triaged`, assigning a responder. Triage IS the assignment. */
  async triage(id: string, assignedTo: string, actor: Actor): Promise<Incident> {
    return this.move(id, 'triaged', actor, AUDIT_ACTION.INCIDENT_TRIAGED, {
      assignedTo,
      detail: `Triaged and assigned`,
    });
  }

  /** `triaged` → `contained`. The clock that matters most in a response stops here. */
  async contain(id: string, containedAt: string | undefined, actor: Actor): Promise<Incident> {
    const incident = await this.getIncident(id);
    const at = this.stampOrNow(containedAt);
    this.assertNotBefore(at, incident.detectedAt, 'Containment', 'detection');

    return this.move(id, 'contained', actor, AUDIT_ACTION.INCIDENT_CONTAINED, {
      containedAt: at,
      detail: 'Contained',
      occurredAt: at,
    });
  }

  /**
   * `contained` → `resolved`, with the root cause.
   *
   * The cause is required by `ck_incident_resolution_evidence`, and refused here first: an incident
   * whose cause nobody has established is still open, whatever the status column says.
   */
  async resolve(
    id: string,
    input: { rootCause: string; resolvedAt?: string },
    actor: Actor,
  ): Promise<Incident> {
    const incident = await this.getIncident(id);
    this.assertEvidence(input.rootCause, 'A root cause of at least 10 characters');
    const at = this.stampOrNow(input.resolvedAt);
    this.assertNotBefore(
      at,
      incident.containedAt ?? incident.detectedAt,
      'Resolution',
      'containment',
    );

    return this.move(id, 'resolved', actor, AUDIT_ACTION.INCIDENT_RESOLVED, {
      resolvedAt: at,
      rootCause: input.rootCause,
      detail: 'Resolved',
      occurredAt: at,
    });
  }

  /**
   * `resolved` → `closed`, with what was learned.
   *
   * ISO 27001 A.5.27 is "learning from information security incidents", so the lesson is required by
   * `ck_incident_closure_evidence`. A closed incident with nothing learned is the box-ticking the
   * clause exists to prevent.
   */
  async close(
    id: string,
    input: { lessonsLearned: string; closedAt?: string },
    actor: Actor,
  ): Promise<Incident> {
    const incident = await this.getIncident(id);
    this.assertEvidence(input.lessonsLearned, 'Lessons learned of at least 10 characters');
    const at = this.stampOrNow(input.closedAt);
    this.assertNotBefore(at, incident.resolvedAt ?? incident.detectedAt, 'Closure', 'resolution');

    return this.move(id, 'closed', actor, AUDIT_ACTION.INCIDENT_CLOSED, {
      closedAt: at,
      lessonsLearned: input.lessonsLearned,
      detail: 'Closed',
      occurredAt: at,
    });
  }

  /**
   * Dismiss it as never having been an incident.
   *
   * Only from `reported` or `triaged`: once something has been contained it demonstrably WAS an
   * incident, and `ck_incident_false_positive` refuses the handling timestamps a later dismissal
   * would leave behind.
   */
  async dismiss(id: string, reason: string, actor: Actor): Promise<Incident> {
    this.assertEvidence(reason, 'A reason of at least 10 characters');
    return this.move(id, 'false_positive', actor, AUDIT_ACTION.INCIDENT_DISMISSED, {
      detail: `Dismissed as a false positive: ${reason}`,
    });
  }

  // ── Timeline ─────────────────────────────────────────────────────────────────

  /**
   * Append a note, a piece of evidence, or a notification record.
   *
   * There is no edit and no delete, deliberately: see the repository. Allowed on a closed incident,
   * because a post-incident review adds to the record after closure and refusing that would push
   * the analysis somewhere the audit trail cannot see it.
   */
  async recordEvent(
    incidentId: string,
    input: RecordEventInput,
    actor: Actor,
  ): Promise<IncidentEvent> {
    const incident = await this.getIncident(incidentId);
    const occurredAt = this.stampOrNow(input.occurredAt);
    this.assertNotBefore(occurredAt, incident.detectedAt, 'A timeline entry', 'detection');

    return this.db.transaction(async (tx) => {
      const event = await this.repo.appendEvent(
        incidentId,
        { ...input, recordedBy: actor.sub, occurredAt },
        tx,
      );
      await this.trail.record(AUDIT_ACTION.INCIDENT_EVENT_RECORDED, incidentId, actor, tx, {
        after: { type: event.type, occurredAt: event.occurredAt },
      });
      return event;
    });
  }

  // ── Breach notification ──────────────────────────────────────────────────────

  /**
   * Record that the regulator was told, and when.
   *
   * Once only, guarded in the repository's WHERE clause: the notification date is what the
   * obligation turns on, and overwriting it would erase whether the 72 hours were met.
   */
  async recordRegulatorNotification(
    id: string,
    notifiedAt: string | undefined,
    actor: Actor,
  ): Promise<Incident> {
    const incident = await this.getIncident(id);
    if (!incident.personalDataBreach) {
      throw new PreconditionFailedException(
        ErrorCodes.INCIDENT_NOT_A_BREACH,
        `Incident ${incident.reference} is not recorded as a personal-data breach, so there is no ` +
          'regulator to notify. Mark it as one first if that is wrong.',
      );
    }
    const at = this.stampOrNow(notifiedAt);
    this.assertNotBefore(at, incident.detectedAt, 'Notification', 'detection');

    return this.db.transaction(async (tx) => {
      const notified = await this.repo.markRegulatorNotified(id, at, tx);
      if (!notified) {
        throw new ConflictException(
          ErrorCodes.CONFLICT,
          `Incident ${incident.reference} has already been notified to the regulator`,
        );
      }
      // The notification is part of the incident's story, so it goes on the timeline too — the
      // append is what a reviewer reads, and the column is what the report queries.
      await this.repo.appendEvent(
        id,
        {
          type: 'notification',
          detail: 'Supervisory authority notified',
          recordedBy: actor.sub,
          occurredAt: at,
        },
        tx,
      );
      await this.trail.record(AUDIT_ACTION.INCIDENT_REGULATOR_NOTIFIED, id, actor, tx, {
        after: { regulatorNotifiedAt: at },
      });
      return notified;
    });
  }

  /** Breaches past the 72-hour deadline with nothing recorded. */
  async overdueBreaches(limit = REPORT_ROW_LIMIT): Promise<OverdueBreach[]> {
    return this.repo.overdueBreaches(limit);
  }

  /** Open incidents nobody linked to a risk — the register's feedback loop. */
  async unlinkedToRisk(limit = REPORT_ROW_LIMIT): Promise<Incident[]> {
    return this.repo.unlinkedToRisk(limit);
  }

  // ── Shared internals ─────────────────────────────────────────────────────────

  /**
   * One transition implementation: check the move is legal, apply it guarded, append the timeline
   * entry and the audit record — all in one transaction.
   *
   * Every caller goes through here so the four cannot drift on which of those steps they do.
   */
  private async move(
    id: string,
    to: IncidentStatus,
    actor: Actor,
    action: AuditAction,
    extra: {
      detail: string;
      occurredAt?: Date;
      assignedTo?: string;
      containedAt?: Date;
      resolvedAt?: Date;
      closedAt?: Date;
      rootCause?: string;
      lessonsLearned?: string;
    },
  ): Promise<Incident> {
    const incident = await this.getIncident(id);
    const { detail, occurredAt, ...columns } = extra;

    if (!ALLOWED_TRANSITIONS[incident.status].includes(to)) {
      throw new PreconditionFailedException(
        ErrorCodes.INCIDENT_NOT_IN_STATE,
        `Incident ${incident.reference} is '${incident.status}' and cannot move to '${to}'. ` +
          `Allowed from here: ${ALLOWED_TRANSITIONS[incident.status].join(', ') || 'nothing — it is finished'}`,
      );
    }

    return this.db.transaction(async (tx) => {
      const moved = await this.repo.transition(id, incident.status, to, columns, tx);
      if (!moved) {
        throw new ConflictException(
          ErrorCodes.INCIDENT_NOT_IN_STATE,
          `Incident ${incident.reference} changed while being updated — somebody else moved it`,
        );
      }

      // Written by the transition, not by the caller remembering to: a timeline can never be
      // missing the step the status column claims happened.
      await this.repo.appendEvent(
        id,
        {
          type: 'status_change',
          detail,
          recordedBy: actor.sub,
          occurredAt: occurredAt ?? new Date(),
        },
        tx,
      );
      await this.trail.record(action, id, actor, tx, {
        before: { status: incident.status },
        after: { status: to },
      });
      return moved;
    });
  }

  private assertOpen(incident: Incident): void {
    if (isTerminalIncidentStatus(incident.status)) {
      throw new PreconditionFailedException(
        ErrorCodes.INCIDENT_NOT_IN_STATE,
        `Incident ${incident.reference} is '${incident.status}' and can no longer be changed. ` +
          'Add a timeline entry instead.',
      );
    }
  }

  /**
   * A regulator notification cannot be un-said, so the flag it depended on cannot be cleared.
   *
   * WHAT THIS ROW LOOKED LIKE WITHOUT THE GUARD: `personal_data_breach = false` alongside a
   * `regulator_notified_at` proving a supervisory authority was told. The record then asserts two
   * contradictory things, and the contradiction is not recoverable — `markRegulatorNotified` matches
   * only `personalDataBreach = true AND regulatorNotifiedAt IS NULL`, and there is no un-notify
   * route, so nothing can restore either half. The incident also drops silently out of
   * `overdueBreaches` and out of `ix_incident_breach_detected`, which filter on exactly that pair:
   * the register a DPO reads stops mentioning an incident that was reported to a regulator.
   *
   * `=== false` rather than a falsy test, because `undefined` means the patch did not mention the
   * field — most patches do not — and treating that as a retraction would refuse a severity change.
   *
   * SETTING IT TO TRUE IS STILL FINE, notified or not: that direction adds an obligation rather than
   * erasing the evidence one was met.
   *
   * `ck_incident_breach_notification_pair` (migration 0033) says the same thing to anything that
   * writes the table without coming through here; this is the half that answers with a code.
   */
  private assertBreachNotRetracted(before: Incident, input: UpdateIncidentInput): void {
    if (input.personalDataBreach === false && before.regulatorNotifiedAt) {
      throw new PreconditionFailedException(
        ErrorCodes.INCIDENT_BREACH_NOTIFIED,
        `Incident ${before.reference} was notified to the supervisory authority on ` +
          `${before.regulatorNotifiedAt.toISOString()}, so it can no longer stop being a ` +
          'personal-data breach. Record the reassessment as a timeline entry instead, which is ' +
          'what a regulator reads.',
      );
    }
  }

  /**
   * Refuse a `riskId` or `assetId` that names no row, saying WHICH field was wrong.
   *
   * Both columns carry real foreign keys (migration 0021), so the database already refuses a
   * dangling reference — but it refuses it as SQLSTATE 23503, which the filter reports as a 500
   * `INTERNAL_ERROR`. A client is then told the server broke, when what happened is that one field
   * of its request pointed at nothing. This is the same restatement every CHECK gets above, applied
   * to the two foreign keys.
   *
   * ONLY THE VALUES THE PATCH CHANGES are resolved. What is already stored satisfies the foreign
   * key by construction, so re-checking an id the caller merely echoed back is a round trip whose
   * answer is known. A `null` is a caller UNLINKING, which needs no target to exist.
   *
   * BOTH ANSWERS ARE COLLECTED BEFORE ANYTHING IS THROWN, and both queries go out together. A patch
   * naming a bad risk and a bad asset must report both: told about one, the caller fixes it,
   * resubmits, and is told about the other — the exact failure `EmployeeService.assertExist` was
   * written to stop repeating.
   *
   * 404 rather than 422, following that helper and the call sites it serves in every module: an
   * unknown reference is a thing that is not there, and the ISMS services already report one as
   * `NOT_FOUND` with the entity named in the message (`Risk … not found`). The GENERIC code, because
   * one refusal can name both fields at once — the field names are the content of the message.
   */
  private async assertReferencesResolve(
    before: Incident,
    input: UpdateIncidentInput,
  ): Promise<void> {
    const riskId = input.riskId && input.riskId !== before.riskId ? input.riskId : null;
    const assetId = input.assetId && input.assetId !== before.assetId ? input.assetId : null;
    if (!riskId && !assetId) return;

    const [riskFound, assetFound] = await Promise.all([
      riskId ? this.repo.riskExists(riskId) : true,
      assetId ? this.repo.assetExists(assetId) : true,
    ]);

    const missing = [
      ...(riskFound ? [] : [`riskId ${riskId}`]),
      ...(assetFound ? [] : [`assetId ${assetId}`]),
    ];
    if (missing.length > 0) {
      throw new NotFoundException(
        ErrorCodes.NOT_FOUND,
        // The FIELD, not only the id: which reference is wrong is the whole content of this failure.
        `Reference not found: ${missing.join(', ')}`,
      );
    }
  }

  private assertEvidence(value: string, what: string): void {
    if (value.trim().length < 10) {
      throw new PreconditionFailedException(
        ErrorCodes.INCIDENT_EVIDENCE_MISSING,
        `${what} is required`,
      );
    }
  }

  /** `ck_incident_timeline_order` stated as a domain rule, because a CHECK violation is a 500. */
  private assertNotBefore(at: Date, floor: Date, what: string, floorName: string): void {
    if (at.getTime() < floor.getTime()) {
      throw new PreconditionFailedException(
        ErrorCodes.INCIDENT_TIMELINE_ORDER,
        `${what} cannot be before ${floorName} (${floor.toISOString()})`,
      );
    }
  }

  /** A supplied timestamp, or now. Responders record most steps as they happen. */
  private stampOrNow(value: string | undefined): Date {
    return value ? new Date(value) : new Date();
  }
}
