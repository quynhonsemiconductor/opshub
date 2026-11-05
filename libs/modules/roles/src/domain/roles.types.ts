import type { roleStatusEnum } from '../../../../../db/schema';
/** Derived from the DB enum so adding a value there cannot leave this list stale. */
export type RoleStatus = (typeof roleStatusEnum.enumValues)[number];

export interface Role {
  id: string;
  code: string;
  title: string;
  department: string;
  /** The role's seniority rank; null when nobody has ranked it. */
  rankId: string | null;
  headcount: number;
  description: string | null;
  status: RoleStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface EmployeeRole {
  id: string;
  employeeId: string;
  roleId: string;
  effectiveFrom: string;
  /** Null while current. Set on transfer or departure — the row is never deleted. */
  effectiveTo: string | null;
  endReason: string | null;
  createdAt: Date;
}

/**
 * An assignment with the job role it was, resolved in the same query.
 *
 * WHY THE JOIN EXISTS. `/v1/roles/me` is `@SelfScoped` — anybody may read their own history — but
 * every route that could turn a `roleId` into a title needs `role.read`, which a plain employee
 * does not hold. So the self-service answer was a list of UUIDs the caller had no way to resolve, which is
 * the same "nobody knows a UUID" problem the SPA's `EntityPicker` exists to remove.
 *
 * A SEPARATE TYPE FROM `EmployeeRole`, not extra optional fields on it: `listAssignmentsForRole`
 * answers the other direction — who held THIS role — where the title is the thing the caller already
 * had. Optional fields would make every reader check which query it came from.
 */
export interface EmployeeRoleWithDetails extends EmployeeRole {
  roleCode: string;
  roleTitle: string;
}

export interface CreateRoleInput {
  code: string;
  title: string;
  department: string;
  rankId?: string | null;
  headcount?: number;
  description?: string | null;
}

export interface RoleFilters {
  /** Free text over title, code and department. */
  search?: string;
  department?: string;
  status?: RoleStatus;
  /** Only roles with at least one unfilled approved slot. */
  vacantOnly?: boolean;
}

/**
 * A role with its occupancy — the number a headcount plan is actually about.
 *
 * `filled` counts OPEN assignments, so someone who left last month is not still occupying a slot.
 * `vacancies` is `headcount - filled`, floored at zero: it can go negative in the data if an
 * approved headcount is REDUCED below current occupancy, which is a real situation (a restructure)
 * and must not be reported as a negative vacancy.
 */
export interface RoleOccupancy extends Role {
  filled: number;
  vacancies: number;
}
