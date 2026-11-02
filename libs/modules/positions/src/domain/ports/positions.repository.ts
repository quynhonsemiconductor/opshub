import type { DbExecutor } from '@platform';
import type {
  CreatePositionInput,
  EmployeePosition,
  EmployeePositionWithRole,
  Position,
  PositionFilters,
  PositionOccupancy,
} from '../positions.types';

export const POSITIONS_REPOSITORY = Symbol('POSITIONS_REPOSITORY');

export interface IPositionsRepository {
  // ── Positions ──────────────────────────────────────────────────────────────
  create(input: CreatePositionInput, tx?: DbExecutor): Promise<Position>;
  findById(id: string, tx?: DbExecutor): Promise<Position | null>;
  findByCode(code: string): Promise<Position | null>;
  /** Positions with occupancy counts — one query, not N+1 over a list. */
  list(
    filters: PositionFilters,
    limit: number,
    offset: number,
  ): Promise<{ rows: PositionOccupancy[]; total: number }>;
  update(
    id: string,
    input: Partial<
      Pick<Position, 'title' | 'department' | 'rankId' | 'headcount' | 'description' | 'status'>
    >,
    tx?: DbExecutor,
  ): Promise<Position | null>;

  // ── Assignments ────────────────────────────────────────────────────────────
  /**
   * Open assignments for a position.
   *
   * Takes `tx` because the headcount check must count inside the assignment transaction — read on
   * the pool and two concurrent assignments both see the last free slot.
   */
  countOpenAssignments(positionId: string, tx?: DbExecutor): Promise<number>;
  findCurrentAssignment(employeeId: string, tx?: DbExecutor): Promise<EmployeePosition | null>;
  /** One assignment, open or closed — the service needs `effective_from` to validate a close. */
  findAssignmentById(id: string, tx?: DbExecutor): Promise<EmployeePosition | null>;
  assign(
    input: { employeeId: string; positionId: string; effectiveFrom: string },
    tx?: DbExecutor,
  ): Promise<EmployeePosition>;
  /** Close an open assignment. Returns null when it was already closed or absent. */
  endAssignment(
    id: string,
    input: { effectiveTo: string; endReason?: string | null },
    tx?: DbExecutor,
  ): Promise<EmployeePosition | null>;
  /** Full occupancy history for one employee, newest first. */
  /** WITH the role each row refers to — see `EmployeePositionWithRole`. */
  listAssignmentsForEmployee(employeeId: string): Promise<EmployeePositionWithRole[]>;
  /** Everyone who has held a position, newest first. */
  listAssignmentsForPosition(positionId: string): Promise<EmployeePosition[]>;
}
