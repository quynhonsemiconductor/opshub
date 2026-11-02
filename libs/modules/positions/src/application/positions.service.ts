import { Inject, Injectable } from '@nestjs/common';
import {
  ConflictException,
  ErrorCodes,
  assertDateOrder,
  InjectDrizzle,
  nameOf,
  resolveEmployeeNames,
  NotFoundException,
  PreconditionFailedException,
  type DrizzleDB,
} from '@platform';
import type { Actor } from '@shared-kernel';
import { AUDIT_ACTION, AUDIT_RESOURCE, AuditService } from '@modules/audit';
import {
  POSITIONS_REPOSITORY,
  type IPositionsRepository,
} from '../domain/ports/positions.repository';
import {
  JOB_RANKS_REPOSITORY,
  type IJobRanksRepository,
} from '../domain/ports/job-ranks.repository';
import type {
  CreatePositionInput,
  EmployeePosition,
  EmployeePositionWithRole,
  Position,
  PositionFilters,
} from '../domain/positions.types';

/**
 * Positions, approved headcount, and occupancy over time.
 *
 * TWO RULES THIS SERVICE OWNS, because the database cannot.
 *
 * 1. HEADCOUNT. "At most `headcount` people hold this position at once" is a count across rows
 *    filtered by `effective_to IS NULL` — not expressible as a unique index, and invisible to a
 *    CHECK constraint, which cannot see other rows. So it is counted here, INSIDE the assignment
 *    transaction: read on the pool instead and two concurrent assignments both see the last free
 *    slot and both take it.
 *
 * 2. TRANSFER IS ONE ACT. Moving someone closes the old assignment and opens the new one in a
 *    single transaction, in that order. The order is forced by
 *    `uq_employee_current_position`: opening first hits the index, which is the intended
 *    behaviour rather than an obstacle — it means a transfer cannot half-happen.
 */
@Injectable()
export class PositionsService {
  constructor(
    @Inject(POSITIONS_REPOSITORY) private readonly repo: IPositionsRepository,
    @Inject(JOB_RANKS_REPOSITORY) private readonly jobRanksRepo: IJobRanksRepository,
    @InjectDrizzle() private readonly db: DrizzleDB,
    private readonly audit: AuditService,
  ) {}

  // ── Positions ────────────────────────────────────────────────────────────────

  async createPosition(input: CreatePositionInput, actor: Actor): Promise<Position> {
    if (await this.repo.findByCode(input.code)) {
      throw new ConflictException(
        ErrorCodes.CONFLICT,
        `Position code '${input.code}' is already in use`,
      );
    }

    await this.assertRankExists(input.rankId);

    return this.db.transaction(async (tx) => {
      const position = await this.repo.create(input, tx);
      await this.audit.record(
        {
          actorId: actor.sub,
          actorEmail: actor.email,
          action: AUDIT_ACTION.POSITION_CREATED,
          resourceType: AUDIT_RESOURCE.POSITION,
          resourceId: position.id,
          changes: {
            after: {
              code: position.code,
              title: position.title,
              department: position.department,
              headcount: position.headcount,
            },
          },
        },
        tx,
      );
      return position;
    });
  }

  async getPosition(id: string): Promise<Position> {
    const position = await this.repo.findById(id);
    if (!position) throw new NotFoundException(ErrorCodes.NOT_FOUND, `Position ${id} not found`);
    return position;
  }

  async listPositions(filters: PositionFilters, limit: number, offset: number) {
    return this.repo.list(filters, limit, offset);
  }

  /**
   * Change a position's definition, including its approved headcount.
   *
   * REDUCING HEADCOUNT BELOW CURRENT OCCUPANCY IS ALLOWED, deliberately. A restructure that cuts
   * three approved seats to two while three people still hold them is a real situation, and
   * refusing it would force someone to be moved out before the plan could be recorded. The
   * over-occupancy is visible as `vacancies: 0` with `filled > headcount`, and no NEW assignment
   * can be made until it resolves — which is where the constraint belongs.
   */
  async updatePosition(
    id: string,
    input: Partial<
      Pick<Position, 'title' | 'department' | 'rankId' | 'headcount' | 'description' | 'status'>
    >,
    actor: Actor,
  ): Promise<Position> {
    const before = await this.getPosition(id);
    await this.assertRankExists(input.rankId);

    return this.db.transaction(async (tx) => {
      const after = await this.repo.update(id, input, tx);
      await this.audit.record(
        {
          actorId: actor.sub,
          actorEmail: actor.email,
          action: AUDIT_ACTION.POSITION_UPDATED,
          resourceType: AUDIT_RESOURCE.POSITION,
          resourceId: id,
          changes: {
            before: { headcount: before.headcount, status: before.status, title: before.title },
            after: { headcount: after!.headcount, status: after!.status, title: after!.title },
          },
        },
        tx,
      );
      return after!;
    });
  }

  /**
   * Refuses a rank id that names no rank, so the caller gets a 404 instead of a foreign-key failure.
   *
   * Args:
   *   rankId: The rank a position is being given. Null or undefined means "no rank" and always passes.
   *
   * Raises:
   *   NotFoundException: If a rank id is given and no such rank exists.
   */
  private async assertRankExists(rankId: string | null | undefined): Promise<void> {
    if (!rankId) return;
    if (!(await this.jobRanksRepo.findById(rankId))) {
      throw new NotFoundException(ErrorCodes.JOB_RANK_NOT_FOUND, `Rank ${rankId} not found`);
    }
  }

  // ── Assignments ──────────────────────────────────────────────────────────────

  /**
   * Put someone into a position, moving them out of their current one if they have it.
   *
   * The whole thing is one transaction: the headcount count, the close, and the open. Splitting it
   * would allow a transfer that vacated the old position without filling the new one.
   */
  async assign(
    input: { employeeId: string; positionId: string; effectiveFrom: string; endReason?: string },
    actor: Actor,
  ): Promise<EmployeePosition> {
    const position = await this.getPosition(input.positionId);

    // A frozen position keeps its occupants but accepts nobody new — the state a hiring pause
    // needs, and the reason `status` is an enum rather than a boolean.
    if (position.status !== 'active') {
      throw new PreconditionFailedException(
        ErrorCodes.PRECONDITION_FAILED,
        `Position ${position.code} is '${position.status}' and cannot accept an assignment`,
      );
    }

    return this.db.transaction(async (tx) => {
      const current = await this.repo.findCurrentAssignment(input.employeeId, tx);
      if (current?.positionId === input.positionId) {
        throw new ConflictException(
          ErrorCodes.CONFLICT,
          'The employee already holds this position',
        );
      }

      // Counted INSIDE the transaction. The slot being vacated by the transfer below is released
      // first, so moving someone within an at-capacity department is not blocked by their own
      // outgoing assignment.
      if (current) {
        // A transfer dated before the current assignment started would close it in its own past.
        assertDateOrder(
          current.effectiveFrom,
          input.effectiveFrom,
          ErrorCodes.POSITION_INVALID_WINDOW,
          'An assignment cannot end before it began — cannot transfer as of this date',
        );
        await this.repo.endAssignment(
          current.id,
          { effectiveTo: input.effectiveFrom, endReason: input.endReason ?? 'transfer' },
          tx,
        );
      }

      const filled = await this.repo.countOpenAssignments(input.positionId, tx);
      if (filled >= position.headcount) {
        throw new PreconditionFailedException(
          ErrorCodes.POSITION_HEADCOUNT_EXCEEDED,
          `Position ${position.code} is at its approved headcount (${position.headcount}). ` +
            `Raise the headcount or end an existing assignment first.`,
        );
      }

      const assignment = await this.repo.assign(input, tx);
      await this.audit.record(
        {
          actorId: actor.sub,
          actorEmail: actor.email,
          action: AUDIT_ACTION.POSITION_ASSIGNED,
          resourceType: AUDIT_RESOURCE.EMPLOYEE_POSITION,
          resourceId: assignment.id,
          changes: {
            before: current ? { positionId: current.positionId } : null,
            after: {
              employeeId: input.employeeId,
              positionId: input.positionId,
              effectiveFrom: input.effectiveFrom,
            },
          },
        },
        tx,
      );
      return assignment;
    });
  }

  /** End an assignment without opening another — departure, or a role being vacated. */
  async endAssignment(
    id: string,
    input: { effectiveTo: string; endReason?: string },
    actor: Actor,
  ): Promise<EmployeePosition> {
    return this.db.transaction(async (tx) => {
      // Read first only to validate the window. The authority on "is it still open" stays the
      // open-only WHERE clause below — this read could be raced, that clause cannot.
      const existing = await this.repo.findAssignmentById(id, tx);
      if (existing && existing.effectiveTo === null) {
        assertDateOrder(
          existing.effectiveFrom,
          input.effectiveTo,
          ErrorCodes.POSITION_INVALID_WINDOW,
          'An assignment cannot end before it began',
        );
      }

      const ended = await this.repo.endAssignment(id, input, tx);
      if (!ended) {
        // The repository's WHERE clause is open-only, so a null means "already closed or absent".
        // Distinguishing the two would need a second read for a message nobody acts on
        // differently — both mean "there is no open assignment with that id".
        throw new NotFoundException(
          ErrorCodes.NOT_FOUND,
          `No open assignment ${id} — it may already have ended`,
        );
      }

      await this.audit.record(
        {
          actorId: actor.sub,
          actorEmail: actor.email,
          action: AUDIT_ACTION.POSITION_UNASSIGNED,
          resourceType: AUDIT_RESOURCE.EMPLOYEE_POSITION,
          resourceId: id,
          changes: {
            after: { effectiveTo: input.effectiveTo, endReason: input.endReason ?? null },
          },
        },
        tx,
      );
      return ended;
    });
  }

  /** Occupancy history for one employee, newest first. */
  async listAssignmentsForEmployee(employeeId: string): Promise<EmployeePositionWithRole[]> {
    return this.repo.listAssignmentsForEmployee(employeeId);
  }

  async listAssignmentsForPosition(
    positionId: string,
  ): Promise<(EmployeePosition & { employeeName: string | null })[]> {
    await this.getPosition(positionId);
    const rows = await this.repo.listAssignmentsForPosition(positionId);
    // Names for the whole list in one query: this is read to answer "who holds this role", which a
    // column of uuids cannot.
    const names = await resolveEmployeeNames(
      this.db,
      rows.map((r) => r.employeeId),
    );
    return rows.map((r) => ({ ...r, employeeName: nameOf(names, r.employeeId) }));
  }

  /** The position an employee holds now, or null when they hold none. */
  async currentAssignment(employeeId: string): Promise<EmployeePosition | null> {
    return this.repo.findCurrentAssignment(employeeId);
  }
}
