import { REPORT_ROW_LIMIT } from '@shared-kernel';
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
import { AUDIT_ACTION, AUDIT_RESOURCE, AuditService } from '@modules/audit';
import { CONTROL_REPOSITORY, type IControlRepository } from '../domain/ports/control.repository';
import { RISK_REPOSITORY, type IRiskRepository } from '../domain/ports/risk.repository';
import type {
  Control,
  ControlFilters,
  CreateControlInput,
  SetSoaEntryInput,
  SoaCoverage,
  SoaEntry,
  SoaFilters,
  UntreatedRisk,
  UpdateControlInput,
} from '../domain/control.types';

/**
 * The control catalogue, the Statement of Applicability, and which controls treat which risk.
 *
 * WHAT THIS SERVICE OWNS THAT THE DATABASE CANNOT
 *
 * 1. THE SoA IS SET WHOLE, never patched. Applicability, justification and status are one statement:
 *    updating them independently is how an entry ends up excluded while its rationale still argues
 *    for inclusion. The repository writes them in one upsert, so the row is never briefly
 *    inconsistent either.
 *
 * 2. A RETIRED CONTROL ACCEPTS NOTHING NEW — no SoA decision, no risk link. The row stays because an
 *    SoA entry from last year's audit references it, and a CHECK cannot express "only if the
 *    referenced row is not retired" without a trigger.
 *
 * 3. APPLICABILITY AND STATUS ARE RESTATED as a coded refusal in front of `ck_soa_applicability`,
 *    because a raw constraint violation reaches the caller as a 500 with no error code.
 *
 * The scoring, ordering and coverage arithmetic all live in SQL — see the repository. There is
 * deliberately no counting here to drift.
 */
@Injectable()
export class ControlService {
  constructor(
    @Inject(CONTROL_REPOSITORY) private readonly repo: IControlRepository,
    @Inject(RISK_REPOSITORY) private readonly risks: IRiskRepository,
    @InjectDrizzle() private readonly db: DrizzleDB,
    private readonly audit: AuditService,
  ) {}

  // ── Catalogue ────────────────────────────────────────────────────────────────

  async createControl(input: CreateControlInput, actor: Actor): Promise<Control> {
    if (await this.repo.findControlByReference(input.reference)) {
      throw new ConflictException(
        ErrorCodes.CONFLICT,
        `Control reference '${input.reference}' is already in the catalogue`,
      );
    }

    return this.db.transaction(async (tx) => {
      const control = await this.repo.createControl(input, tx);
      await this.audit.recordChange(
        actor,
        AUDIT_ACTION.CONTROL_CREATED,
        AUDIT_RESOURCE.CONTROL,
        control.id,
        {
          after: { reference: control.reference, title: control.title, theme: control.theme },
        },
        tx,
      );
      return control;
    });
  }

  async getControl(id: string): Promise<Control> {
    const control = await this.repo.findControlById(id);
    if (!control) throw new NotFoundException(ErrorCodes.NOT_FOUND, `Control ${id} not found`);
    return control;
  }

  async listControls(filters: ControlFilters, limit: number, offset: number) {
    return this.repo.listControls(filters, limit, offset);
  }

  async updateControl(id: string, input: UpdateControlInput, actor: Actor): Promise<Control> {
    const before = await this.getControl(id);

    return this.db.transaction(async (tx) => {
      const after = await this.repo.updateControl(id, input, tx);
      await this.audit.recordChange(
        actor,
        AUDIT_ACTION.CONTROL_UPDATED,
        AUDIT_RESOURCE.CONTROL,
        id,
        {
          before: { title: before.title, theme: before.theme },
          after: { title: after!.title, theme: after!.theme },
        },
        tx,
      );
      return after!;
    });
  }

  /** Retire a control. Its SoA entry and risk links stay — they are the historical evidence. */
  async retireControl(id: string, actor: Actor): Promise<Control> {
    await this.getControl(id);

    return this.db.transaction(async (tx) => {
      const retired = await this.repo.retireControl(id, tx);
      if (!retired) {
        throw new PreconditionFailedException(
          ErrorCodes.CONTROL_RETIRED,
          'That control is already retired',
        );
      }
      await this.audit.recordChange(
        actor,
        AUDIT_ACTION.CONTROL_RETIRED,
        AUDIT_RESOURCE.CONTROL,
        id,
        {
          after: { retiredAt: retired.retiredAt },
        },
        tx,
      );
      return retired;
    });
  }

  // ── Statement of Applicability ───────────────────────────────────────────────

  /**
   * Record the decision about one control — insert or replace, never patch.
   *
   * The whole statement arrives together because that is what it is: an excluded control with an
   * inclusion rationale is not a partially-updated row, it is a wrong document.
   */
  async setEntry(controlId: string, input: SetSoaEntryInput, actor: Actor): Promise<SoaEntry> {
    const control = await this.getControl(controlId);
    if (control.retiredAt) {
      throw new PreconditionFailedException(
        ErrorCodes.CONTROL_RETIRED,
        `Control ${control.reference} is retired and cannot be part of the current statement`,
      );
    }
    this.assertConsistent(input);

    const before = await this.repo.findEntryByControl(controlId);

    return this.db.transaction(async (tx) => {
      const entry = await this.repo.upsertEntry(controlId, input, tx);
      await this.audit.recordChange(
        actor,
        AUDIT_ACTION.SOA_ENTRY_SET,
        AUDIT_RESOURCE.SOA_ENTRY,
        entry.id,
        {
          before: before ? { applicable: before.applicable, status: before.status } : null,
          after: {
            controlReference: control.reference,
            applicable: entry.applicable,
            status: entry.status,
          },
        },
        tx,
      );
      return entry;
    });
  }

  async listEntries(filters: SoaFilters, limit: number, offset: number) {
    const page = await this.repo.listEntries(filters, limit, offset);
    /*
     * OWNER NAMES for the whole page, in one query.
     *
     * The highest-value one of these in the module: this is a LIST COLUMN, so the uuid was repeated
     * once per row down the document an ISO 27001 audit opens with, and "who owns this control" is
     * the question asked of every line of it. Resolved here rather than in the SPA because the
     * directory endpoint needs `employee.read`, which a `control.read` holder is not required to
     * have — and because a name per row would otherwise be a request per row.
     *
     * `ownerId` is nullable here, unlike on a risk or an asset. `resolveEmployeeNames` drops nulls
     * and issues no query at all when a page has none, so an undecided-owner statement costs nothing.
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

  async getEntry(controlId: string): Promise<SoaEntry> {
    const entry = await this.repo.findEntryByControl(controlId);
    if (!entry) {
      // An absent entry is a real state — "not yet decided" — so this 404 is informative rather
      // than a lookup failure.
      throw new NotFoundException(
        ErrorCodes.NOT_FOUND,
        'No Statement of Applicability entry for that control yet',
      );
    }
    return entry;
  }

  /**
   * One statement entry, with its owner named — the single-entry read path.
   *
   * Separate from `getEntry` rather than folded into it, because that one is the guard `markReviewed`
   * calls first, and stamping a review renders nothing. Widening it would have put a lookup in front
   * of a mutation whose response the SPA discards.
   */
  async getEntryWithOwner(controlId: string): Promise<SoaEntry & { ownerName: string | null }> {
    const entry = await this.getEntry(controlId);
    const names = await resolveEmployeeNames(this.db, [entry.ownerId]);
    return { ...entry, ownerName: nameOf(names, entry.ownerId) };
  }

  /** Stamp a review as having happened, and optionally move the next one. */
  async markReviewed(
    controlId: string,
    reviewDueOn: string | null,
    actor: Actor,
  ): Promise<SoaEntry> {
    await this.getEntry(controlId);

    return this.db.transaction(async (tx) => {
      const reviewed = await this.repo.markReviewed(controlId, reviewDueOn, tx);
      if (!reviewed) {
        throw new ConflictException(
          ErrorCodes.NOT_FOUND,
          'That entry disappeared while being reviewed',
        );
      }
      await this.audit.recordChange(
        actor,
        AUDIT_ACTION.SOA_ENTRY_REVIEWED,
        AUDIT_RESOURCE.SOA_ENTRY,
        reviewed.id,
        { after: { lastReviewedAt: reviewed.lastReviewedAt, reviewDueOn: reviewed.reviewDueOn } },
        tx,
      );
      return reviewed;
    });
  }

  // ── Risk ↔ control ───────────────────────────────────────────────────────────

  async linkRisk(riskId: string, controlId: string, actor: Actor): Promise<void> {
    const risk = await this.risks.findById(riskId);
    if (!risk) throw new NotFoundException(ErrorCodes.NOT_FOUND, `Risk ${riskId} not found`);
    const control = await this.getControl(controlId);
    if (control.retiredAt) {
      throw new PreconditionFailedException(
        ErrorCodes.CONTROL_RETIRED,
        `Control ${control.reference} is retired and cannot be assigned to treat a risk`,
      );
    }

    await this.db.transaction(async (tx) => {
      await this.repo.linkRiskControl(riskId, controlId, actor.sub, tx);
      await this.audit.recordChange(
        actor,
        AUDIT_ACTION.RISK_CONTROL_LINKED,
        AUDIT_RESOURCE.RISK,
        riskId,
        {
          after: { controlId, controlReference: control.reference },
        },
        tx,
      );
    });
  }

  async unlinkRisk(riskId: string, controlId: string, actor: Actor): Promise<void> {
    await this.db.transaction(async (tx) => {
      const removed = await this.repo.unlinkRiskControl(riskId, controlId, tx);
      if (!removed) {
        throw new NotFoundException(
          ErrorCodes.NOT_FOUND,
          'That control is not linked to this risk',
        );
      }
      await this.audit.recordChange(
        actor,
        AUDIT_ACTION.RISK_CONTROL_UNLINKED,
        AUDIT_RESOURCE.RISK,
        riskId,
        { before: { controlId } },
        tx,
      );
    });
  }

  async listControlsForRisk(riskId: string) {
    const risk = await this.risks.findById(riskId);
    if (!risk) throw new NotFoundException(ErrorCodes.NOT_FOUND, `Risk ${riskId} not found`);
    return this.repo.listControlsForRisk(riskId);
  }

  async listRisksForControl(controlId: string) {
    await this.getControl(controlId);
    return this.repo.listRisksForControl(controlId);
  }

  // ── Reports ──────────────────────────────────────────────────────────────────

  /** The number an ISO 27001 audit opens with. */
  async coverage(): Promise<SoaCoverage> {
    return this.repo.soaCoverage();
  }

  /** Open risks that no control treats — the gap the link table exists to expose. */
  async untreatedRisks(limit = REPORT_ROW_LIMIT): Promise<UntreatedRisk[]> {
    return this.repo.untreatedRisks(limit);
  }

  // ── Shared internals ─────────────────────────────────────────────────────────

  /** `ck_soa_applicability` stated as a domain rule, because a CHECK violation is a 500. */
  private assertConsistent(input: SetSoaEntryInput): void {
    const notApplicable = input.status === 'not_applicable';
    if (input.applicable && notApplicable) {
      throw new PreconditionFailedException(
        ErrorCodes.SOA_INCONSISTENT,
        'An applicable control cannot have status `not_applicable`',
      );
    }
    if (!input.applicable && !notApplicable) {
      throw new PreconditionFailedException(
        ErrorCodes.SOA_INCONSISTENT,
        `An excluded control must have status \`not_applicable\`, not '${input.status}' — ` +
          'an excluded control cannot also be implemented',
      );
    }
  }
}
