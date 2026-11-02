import type { DbExecutor } from '@platform';
import type {
  CreateRoleInput,
  EmployeeRole,
  EmployeeRoleWithDetails,
  Role,
  RoleFilters,
  RoleOccupancy,
} from '../roles.types';

export const ROLES_REPOSITORY = Symbol('ROLES_REPOSITORY');

export interface IRolesRepository {
  // ── Roles ──────────────────────────────────────────────────────────────
  create(input: CreateRoleInput, tx?: DbExecutor): Promise<Role>;
  findById(id: string, tx?: DbExecutor): Promise<Role | null>;
  findByCode(code: string): Promise<Role | null>;
  /** Roles with occupancy counts — one query, not N+1 over a list. */
  list(
    filters: RoleFilters,
    limit: number,
    offset: number,
  ): Promise<{ rows: RoleOccupancy[]; total: number }>;
  update(
    id: string,
    input: Partial<
      Pick<Role, 'title' | 'department' | 'rankId' | 'headcount' | 'description' | 'status'>
    >,
    tx?: DbExecutor,
  ): Promise<Role | null>;

  // ── Assignments ────────────────────────────────────────────────────────────
  /**
   * Open assignments for a role.
   *
   * Takes `tx` because the headcount check must count inside the assignment transaction — read on
   * the pool and two concurrent assignments both see the last free slot.
   */
  countOpenAssignments(roleId: string, tx?: DbExecutor): Promise<number>;
  findCurrentAssignment(employeeId: string, tx?: DbExecutor): Promise<EmployeeRole | null>;
  /** One assignment, open or closed — the service needs `effective_from` to validate a close. */
  findAssignmentById(id: string, tx?: DbExecutor): Promise<EmployeeRole | null>;
  assign(
    input: { employeeId: string; roleId: string; effectiveFrom: string },
    tx?: DbExecutor,
  ): Promise<EmployeeRole>;
  /** Close an open assignment. Returns null when it was already closed or absent. */
  endAssignment(
    id: string,
    input: { effectiveTo: string; endReason?: string | null },
    tx?: DbExecutor,
  ): Promise<EmployeeRole | null>;
  /** Full occupancy history for one employee, newest first. */
  /** WITH the role each row refers to — see `EmployeeRoleWithDetails`. */
  listAssignmentsForEmployee(employeeId: string): Promise<EmployeeRoleWithDetails[]>;
  /** Everyone who has held a role, newest first. */
  listAssignmentsForRole(roleId: string): Promise<EmployeeRole[]>;
}
