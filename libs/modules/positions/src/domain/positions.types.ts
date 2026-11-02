import type { positionStatusEnum } from '../../../../../db/schema';
/** Derived from the DB enum so adding a value there cannot leave this list stale. */
export type PositionStatus = (typeof positionStatusEnum.enumValues)[number];

export interface Position {
  id: string;
  code: string;
  title: string;
  department: string;
  /** The position's seniority rank; null when nobody has ranked it. */
  rankId: string | null;
  headcount: number;
  description: string | null;
  status: PositionStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface EmployeePosition {
  id: string;
  employeeId: string;
  positionId: string;
  effectiveFrom: string;
  /** Null while current. Set on transfer or departure — the row is never deleted. */
  effectiveTo: string | null;
  endReason: string | null;
  createdAt: Date;
}

/**
 * An assignment with the ROLE IT WAS, resolved in the same query.
 *
 * WHY THE JOIN EXISTS. `/v1/positions/me` is `@SelfScoped` — anybody may read their own history — but
 * every route that could turn a `positionId` into a title needs `position.read`, which a plain employee
 * does not hold. So the self-service answer was a list of UUIDs the caller had no way to resolve, which is
 * the same "nobody knows a UUID" problem the SPA's `EntityPicker` exists to remove.
 *
 * A SEPARATE TYPE FROM `EmployeePosition`, not extra optional fields on it: `listAssignmentsForPosition`
 * answers the other direction — who held THIS position — where the title is the thing the caller already
 * had. Optional fields would make every reader check which query it came from.
 */
export interface EmployeePositionWithRole extends EmployeePosition {
  positionCode: string;
  positionTitle: string;
}

export interface CreatePositionInput {
  code: string;
  title: string;
  department: string;
  rankId?: string | null;
  headcount?: number;
  description?: string | null;
}

export interface PositionFilters {
  /** Free text over title, code and department. */
  search?: string;
  department?: string;
  status?: PositionStatus;
  /** Only positions with at least one unfilled approved slot. */
  vacantOnly?: boolean;
}

/**
 * A position with its occupancy — the number a headcount plan is actually about.
 *
 * `filled` counts OPEN assignments, so someone who left last month is not still occupying a slot.
 * `vacancies` is `headcount - filled`, floored at zero: it can go negative in the data if an
 * approved headcount is REDUCED below current occupancy, which is a real situation (a restructure)
 * and must not be reported as a negative vacancy.
 */
export interface PositionOccupancy extends Position {
  filled: number;
  vacancies: number;
}
