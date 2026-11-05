import type { DbExecutor } from '@platform';
import type { EmployeeGroup, MembershipSource, ScopeType } from '@platform';

export const EMPLOYEE_GROUP_REPOSITORY = Symbol('EMPLOYEE_GROUP_REPOSITORY');

export interface AssignGroupInput {
  employeeId: string;
  groupId: string;
  scopeType: ScopeType;
  scopeId: string | null;
  grantedBy: string;
  /** Who is making the membership; a person unless the sign-in sync says otherwise. */
  source?: MembershipSource;
  expiresAt: Date | null;
}

export interface IEmployeeGroupRepository {
  listForEmployee(employeeId: string): Promise<EmployeeGroup[]>;
  /**
   * Distinct users holding this group, in any scope. Needed because a change to a
   * GROUP's definition changes what every holder can do, and each holder's resolved
   * permissions are cached per user — so the write path has to know whose cache to
   * drop.
   */
  listEmployeeIdsForGroup(groupId: string): Promise<string[]>;
  findById(id: string): Promise<EmployeeGroup | null>;
  /** Idempotent grant — returns the existing row when the scope already exists. */
  assign(input: AssignGroupInput, tx?: DbExecutor): Promise<EmployeeGroup>;
  revoke(id: string, tx?: DbExecutor): Promise<void>;
  /**
   * Recompute the user's distinct active group keys from employee_groups
   * and write them to employees.groups (the JSONB cache used for the JWT claim).
   * Keeps the token's groups[] in sync with the RBAC source of truth.
   */
  syncEmployeeGroupKeys(employeeId: string): Promise<string[]>;
}
