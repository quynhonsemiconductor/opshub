import { Inject, Injectable } from '@nestjs/common';
import {
  ConflictException,
  ErrorCodes,
  InjectDrizzle,
  NotFoundException,
  PreconditionFailedException,
  RequestEngine,
  nameOf,
  resolveEmployeeNames,
  type DbExecutor,
  type DrizzleDB,
} from '@platform';
import { REQUEST_TYPE, today, type Actor } from '@shared-kernel';
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE,
  AuditService,
  type ResourceAuditTrail,
} from '@modules/audit';
import { RISK_REPOSITORY, type IRiskRepository } from '../domain/ports/risk.repository';
import type {
  AddTreatmentInput,
  IdentifyRiskInput,
  Risk,
  RiskFilters,
  RiskScore,
  RiskTreatment,
  TreatmentDecision,
  UpdateRiskInput,
  UpdateTreatmentInput,
} from '../domain/risk.types';
import type { RiskAcceptancePayload } from './risk-acceptance.type-def';

/**
 * The residual score at or above which acceptance needs sign-off rather than a note.
 *
 * 12 on a 5x5 matrix is the "high" band in the policy this models — 3x4 and above. Below it, a risk
 * owner accepting their own residual is proportionate; above it, somebody accountable has to put
 * their name to carrying the exposure, which is what `risk.accept` and the request engine are for.
 */
export const ACCEPTANCE_APPROVAL_THRESHOLD = 12;

/**
 * The ISMS risk register: identify, assess, treat, accept, close.
 *
 * WHAT THIS SERVICE OWNS THAT THE DATABASE CANNOT
 *
 * 1. THE LIFECYCLE. The CHECKs describe a valid ROW — factors in range, residual no worse than
 *    inherent, acceptance evidenced. They say nothing about which move is allowed from which state,
 *    because a CHECK cannot see the previous value. "Only an assessed risk may be treated", "a risk
 *    with outstanding treatment actions is not treated", "a closed risk is closed" live here, and
 *    each is ALSO a guarded `WHERE status = <from>` in the repository so a race is Postgres's
 *    decision rather than whoever read first.
 *
 * 2. ACCEPTANCE IS AN APPROVAL, NOT A FIELD WRITE. Above `ACCEPTANCE_APPROVAL_THRESHOLD` the
 *    service does not set `accepted`; it submits a `risk_acceptance` request and lets the engine run
 *    the chain — separation of duties, delegation, SLA, audit. `RiskAcceptanceTypeDef.onApprove` is
 *    what finally flips the row, inside the engine's transaction. That is the roadmap's "one
 *    approval spine" decision being cashed in rather than restated.
 *
 * 3. SCORES ARE NEVER WRITTEN. `inherent_score` and `residual_score` are generated columns, so this
 *    service passes factors and reads scores. There is deliberately no arithmetic here to drift.
 */
@Injectable()
export class RiskService {
  private readonly trail: ResourceAuditTrail;

  constructor(
    @Inject(RISK_REPOSITORY) private readonly repo: IRiskRepository,
    @InjectDrizzle() private readonly db: DrizzleDB,
    private readonly audit: AuditService,
    private readonly engine: RequestEngine,
  ) {
    // Resource type named ONCE — see `AuditService.forResource`.
    this.trail = audit.forResource(AUDIT_RESOURCE.RISK);
  }

  // ── Reads ────────────────────────────────────────────────────────────────────

  async getRisk(id: string): Promise<Risk> {
    const risk = await this.repo.findById(id);
    if (!risk) throw new NotFoundException(ErrorCodes.NOT_FOUND, `Risk ${id} not found`);
    return risk;
  }

  /**
   * One risk, with its owner named — the drawer's read path.
   *
   * Separate from `getRisk` rather than folded into it, because that one is the guard every write
   * path calls first (assess, treat, accept, close, update) and none of those render an owner.
   * Widening it would have added a lookup to eight mutations to serve one screen.
   */
  async getRiskWithOwner(
    id: string,
  ): Promise<Risk & { ownerName: string | null; acceptedByName: string | null }> {
    const risk = await this.getRisk(id);
    // Owner and acceptor together: the drawer shows both, and one query answers both.
    const names = await resolveEmployeeNames(this.db, [risk.ownerId, risk.acceptedBy]);
    return {
      ...risk,
      ownerName: nameOf(names, risk.ownerId),
      acceptedByName: nameOf(names, risk.acceptedBy),
    };
  }

  async listRisks(filters: RiskFilters, limit: number, offset: number) {
    const page = await this.repo.list(filters, limit, offset);
    /*
     * OWNER NAMES for the whole page, in one query.
     *
     * A risk's owner is the person accountable for carrying or reducing the exposure — the single
     * fact the register is read for after the score — and the drawer answered it with thirty-six
     * characters that identify nobody. Resolved here rather than in the SPA because the directory
     * endpoint needs `employee.read`, and the roles holding an ISMS bundle are exactly the ones not
     * required to hold it.
     */
    /*
     * `acceptedBy` rides the SAME query. It is the SIGNATURE on a risk acceptance — the one field an
     * ISO 27001 auditor reads, because accepting an exposure is a decision somebody is answerable
     * for — and it was rendered as "accepted at <date> by <uuid>". The resolver deduplicates, so a
     * register where one person accepted twenty risks adds one id, not twenty.
     */
    const names = await resolveEmployeeNames(this.db, [
      ...page.rows.map((r) => r.ownerId),
      ...page.rows.map((r) => r.acceptedBy),
    ]);
    return {
      ...page,
      rows: page.rows.map((r) => ({
        ...r,
        ownerName: nameOf(names, r.ownerId),
        acceptedByName: nameOf(names, r.acceptedBy),
      })),
    };
  }

  async listTreatments(riskId: string): Promise<RiskTreatment[]> {
    await this.getRisk(riskId);
    return this.repo.listTreatments(riskId);
  }

  // ── Identify and assess ──────────────────────────────────────────────────────

  async identifyRisk(input: IdentifyRiskInput, actor: Actor): Promise<Risk> {
    if (await this.repo.findByReference(input.reference)) {
      throw new ConflictException(
        ErrorCodes.CONFLICT,
        `Risk reference '${input.reference}' is already in use`,
      );
    }

    return this.db.transaction(async (tx) => {
      const risk = await this.repo.create(input, tx);
      await this.trail.record(AUDIT_ACTION.RISK_IDENTIFIED, risk.id, actor, tx, {
        after: {
          reference: risk.reference,
          title: risk.title,
          inherentScore: risk.inherentScore,
          ownerId: risk.ownerId,
        },
      });
      return risk;
    });
  }

  /**
   * Change a risk's description or its inherent score.
   *
   * Allowed in any state except `closed`: re-scoring an accepted risk is how a register stays
   * honest when the world changes, and the acceptance evidence stays attached to it. A closed risk
   * is history.
   */
  async updateRisk(id: string, input: UpdateRiskInput, actor: Actor): Promise<Risk> {
    const before = await this.getRisk(id);
    this.assertNotClosed(before);

    if (input.inherent && before.residualLikelihood !== null) {
      // The database's `ck_risk_residual_not_worse` compares the factors, so lowering inherent below
      // an existing residual would be refused as a 500 with no code. Say it properly.
      const residual = before.residualLikelihood * (before.residualImpact ?? 0);
      if (input.inherent.likelihood * input.inherent.impact < residual) {
        throw new PreconditionFailedException(
          ErrorCodes.RISK_INVALID_SCORE,
          `Inherent score cannot drop below the recorded residual score (${residual}). ` +
            'Re-assess the residual first.',
        );
      }
    }

    return this.db.transaction(async (tx) => {
      const after = await this.repo.update(id, input, tx);
      await this.trail.record(AUDIT_ACTION.RISK_UPDATED, id, actor, tx, {
        before: { inherentScore: before.inherentScore, ownerId: before.ownerId },
        after: { inherentScore: after!.inherentScore, ownerId: after!.ownerId },
      });
      return after!;
    });
  }

  /**
   * Record the treatment DECISION and the residual score — `identified` → `assessed`.
   *
   * The decision is what the rest of the lifecycle branches on: `mitigate` expects treatment
   * actions, `accept` expects sign-off, `transfer` and `avoid` are recorded and reviewed.
   */
  async assessRisk(
    id: string,
    input: { decision: TreatmentDecision; residual: RiskScore; reviewDueOn?: string | null },
    actor: Actor,
  ): Promise<Risk> {
    const risk = await this.getRisk(id);
    this.assertNotClosed(risk);
    this.assertResidualNotWorse(risk, input.residual);

    return this.db.transaction(async (tx) => {
      const assessed = await this.repo.transition(
        id,
        risk.status,
        'assessed',
        {
          treatmentDecision: input.decision,
          residualLikelihood: input.residual.likelihood,
          residualImpact: input.residual.impact,
          ...(input.reviewDueOn === undefined ? {} : { reviewDueOn: input.reviewDueOn }),
        },
        tx,
      );
      if (!assessed) {
        throw new ConflictException(
          ErrorCodes.RISK_NOT_IN_STATE,
          `Risk ${risk.reference} changed while being assessed`,
        );
      }
      await this.trail.record(AUDIT_ACTION.RISK_ASSESSED, id, actor, tx, {
        before: { status: risk.status },
        after: {
          status: 'assessed',
          decision: input.decision,
          residualScore: assessed.residualScore,
        },
      });
      return assessed;
    });
  }

  // ── Treat ────────────────────────────────────────────────────────────────────

  async addTreatment(input: AddTreatmentInput, actor: Actor): Promise<RiskTreatment> {
    const risk = await this.getRisk(input.riskId);
    this.assertNotClosed(risk);

    return this.db.transaction(async (tx) => {
      const treatment = await this.repo.addTreatment(input, tx);
      await this.audit.record(
        {
          actorId: actor.sub,
          actorEmail: actor.email,
          action: AUDIT_ACTION.RISK_TREATMENT_ADDED,
          resourceType: AUDIT_RESOURCE.RISK_TREATMENT,
          resourceId: treatment.id,
          changes: { after: { riskId: risk.id, description: treatment.description } },
        },
        tx,
      );
      return treatment;
    });
  }

  async updateTreatment(
    id: string,
    input: UpdateTreatmentInput,
    actor: Actor,
  ): Promise<RiskTreatment> {
    const before = await this.repo.findTreatmentById(id);
    if (!before) throw new NotFoundException(ErrorCodes.NOT_FOUND, `Treatment ${id} not found`);

    // `ck_treatment_done_evidence` pairs `done` with a completion date. Defaulting it here rather
    // than refusing keeps the common call — "mark this done" — from needing today's date twice.
    const patch: UpdateTreatmentInput = { ...input };
    if (patch.status === 'done' && patch.completedOn === undefined && before.completedOn === null) {
      patch.completedOn = today();
    }
    if (patch.status && patch.status !== 'done' && before.completedOn !== null) {
      patch.completedOn = null;
    }

    return this.db.transaction(async (tx) => {
      const after = await this.repo.updateTreatment(id, patch, tx);
      await this.audit.record(
        {
          actorId: actor.sub,
          actorEmail: actor.email,
          action: AUDIT_ACTION.RISK_TREATMENT_UPDATED,
          resourceType: AUDIT_RESOURCE.RISK_TREATMENT,
          resourceId: id,
          changes: {
            before: { status: before.status },
            after: { status: after!.status, completedOn: after!.completedOn },
          },
        },
        tx,
      );
      return after!;
    });
  }

  /**
   * Declare the treatment plan complete — `assessed` → `treated`.
   *
   * Refused while any action is still `planned` or `in_progress`, counted INSIDE the transaction:
   * "treated" is the claim an auditor checks first, and a register where it can be true with
   * outstanding work is worse than one with no status at all.
   */
  async markTreated(
    id: string,
    input: { residual?: RiskScore; reviewDueOn?: string | null },
    actor: Actor,
  ): Promise<Risk> {
    const risk = await this.getRisk(id);
    if (risk.status !== 'assessed') {
      throw new PreconditionFailedException(
        ErrorCodes.RISK_NOT_IN_STATE,
        `Risk ${risk.reference} is '${risk.status}' — only an assessed risk may be marked treated`,
      );
    }
    if (input.residual) this.assertResidualNotWorse(risk, input.residual);

    return this.db.transaction(async (tx) => {
      const outstanding = await this.repo.countOutstandingTreatments(id, tx);
      if (outstanding > 0) {
        throw new PreconditionFailedException(
          ErrorCodes.RISK_TREATMENT_OUTSTANDING,
          `${outstanding} treatment action(s) are still open on ${risk.reference}`,
        );
      }

      const treated = await this.repo.transition(
        id,
        'assessed',
        'treated',
        {
          ...(input.residual
            ? {
                residualLikelihood: input.residual.likelihood,
                residualImpact: input.residual.impact,
              }
            : {}),
          ...(input.reviewDueOn === undefined ? {} : { reviewDueOn: input.reviewDueOn }),
        },
        tx,
      );
      if (!treated) {
        throw new ConflictException(
          ErrorCodes.RISK_NOT_IN_STATE,
          `Risk ${risk.reference} changed while being marked treated`,
        );
      }
      await this.trail.record(AUDIT_ACTION.RISK_TREATED, id, actor, tx, {
        before: { status: 'assessed' },
        after: { status: 'treated', residualScore: treated.residualScore },
      });
      return treated;
    });
  }

  // ── Accept ───────────────────────────────────────────────────────────────────

  /**
   * Accept the residual risk rather than treating it further.
   *
   * BELOW the threshold this records the acceptance directly. AT OR ABOVE it, the service submits a
   * `risk_acceptance` request and returns the risk unchanged — the engine runs the chain and
   * `RiskAcceptanceTypeDef.onApprove` flips the row. The caller can tell the two apart from the
   * returned status, and `requestId` says where the approval went.
   */
  async acceptRisk(
    id: string,
    input: { justification: string; reviewDueOn?: string | null },
    actor: Actor,
  ): Promise<{ risk: Risk; requestId: string | null }> {
    const risk = await this.getRisk(id);
    this.assertNotClosed(risk);
    if (risk.residualLikelihood === null) {
      throw new PreconditionFailedException(
        ErrorCodes.RISK_NOT_IN_STATE,
        `Risk ${risk.reference} has no residual score — assess it before accepting it`,
      );
    }
    if (risk.status === 'accepted') {
      throw new PreconditionFailedException(
        ErrorCodes.RISK_NOT_IN_STATE,
        `Risk ${risk.reference} is already accepted`,
      );
    }

    const residualScore = risk.residualScore ?? 0;
    if (residualScore >= ACCEPTANCE_APPROVAL_THRESHOLD) {
      const payload: RiskAcceptancePayload = {
        riskId: risk.id,
        riskReference: risk.reference,
        riskTitle: risk.title,
        residualScore,
        justification: input.justification,
        reviewDueOn: input.reviewDueOn ?? null,
      };
      const request = await this.engine.submit(REQUEST_TYPE.RISK_ACCEPTANCE, payload, actor);

      await this.db.transaction(async (tx) => {
        await this.trail.record(AUDIT_ACTION.RISK_ACCEPTANCE_REQUESTED, id, actor, tx, {
          after: { requestId: request.id, residualScore },
        });
      });
      // Unchanged on purpose: nothing is accepted until somebody approves it.
      return { risk, requestId: request.id };
    }

    const accepted = await this.applyAcceptance(
      risk,
      {
        approverId: actor.sub,
        justification: input.justification,
        reviewDueOn: input.reviewDueOn ?? null,
        requestId: null,
      },
      actor,
    );
    return { risk: accepted, requestId: null };
  }

  /**
   * Flip a risk to `accepted`. Shared by the direct path and the engine's `onApprove`.
   *
   * One implementation so the two paths cannot drift on which columns acceptance sets — the CHECK
   * requires who, when and why together, and a second copy is how one of them gets forgotten.
   */
  async applyAcceptance(
    risk: Risk,
    input: {
      approverId: string;
      justification: string;
      reviewDueOn: string | null;
      requestId: string | null;
    },
    actor: Actor,
    tx?: DbExecutor,
  ): Promise<Risk> {
    const run = async (executor: DbExecutor): Promise<Risk> => {
      const accepted = await this.repo.transition(
        risk.id,
        risk.status,
        'accepted',
        {
          acceptedBy: input.approverId,
          acceptedAt: new Date(),
          acceptanceJustification: input.justification,
          acceptedViaRequestId: input.requestId,
          ...(input.reviewDueOn === null ? {} : { reviewDueOn: input.reviewDueOn }),
        },
        executor,
      );
      if (!accepted) {
        throw new ConflictException(
          ErrorCodes.RISK_NOT_IN_STATE,
          `Risk ${risk.reference} changed while being accepted`,
        );
      }
      await this.trail.record(AUDIT_ACTION.RISK_ACCEPTED, risk.id, actor, executor, {
        before: { status: risk.status },
        after: {
          status: 'accepted',
          acceptedBy: input.approverId,
          requestId: input.requestId,
          residualScore: accepted.residualScore,
        },
      });
      return accepted;
    };

    // Reuses the engine's transaction when called from `onApprove`, so the approval decision and
    // the risk's new state commit together.
    return tx ? run(tx) : this.db.transaction(run);
  }

  // ── Close ────────────────────────────────────────────────────────────────────

  /** Close a risk — it no longer applies. The reason is required and never deleted. */
  async closeRisk(id: string, note: string, actor: Actor): Promise<Risk> {
    const risk = await this.getRisk(id);
    this.assertNotClosed(risk);

    return this.db.transaction(async (tx) => {
      const closed = await this.repo.transition(
        id,
        risk.status,
        'closed',
        {
          closedAt: new Date(),
          closureNote: note,
        },
        tx,
      );
      if (!closed) {
        throw new ConflictException(
          ErrorCodes.RISK_NOT_IN_STATE,
          `Risk ${risk.reference} changed while being closed`,
        );
      }
      await this.trail.record(AUDIT_ACTION.RISK_CLOSED, id, actor, tx, {
        before: { status: risk.status },
        after: { status: 'closed', closureNote: note },
      });
      return closed;
    });
  }

  // ── Shared internals ─────────────────────────────────────────────────────────

  private assertNotClosed(risk: Risk): void {
    if (risk.status === 'closed') {
      throw new PreconditionFailedException(
        ErrorCodes.RISK_NOT_IN_STATE,
        `Risk ${risk.reference} is closed and cannot be changed`,
      );
    }
  }

  /** `ck_risk_residual_not_worse` stated as a domain rule, because a CHECK violation is a 500. */
  private assertResidualNotWorse(risk: Risk, residual: RiskScore): void {
    const inherent = risk.inherentLikelihood * risk.inherentImpact;
    if (residual.likelihood * residual.impact > inherent) {
      throw new PreconditionFailedException(
        ErrorCodes.RISK_INVALID_SCORE,
        `Residual score (${residual.likelihood * residual.impact}) cannot exceed the inherent ` +
          `score (${inherent}) — treatment reduces risk, it does not add to it`,
      );
    }
  }
}
