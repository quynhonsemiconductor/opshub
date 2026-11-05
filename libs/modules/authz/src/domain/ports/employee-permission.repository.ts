import type { DbExecutor, EmployeePermission, ScopeType } from '@platform';
import type { GrantOutcome } from '../grant-outcome';

export const EMPLOYEE_PERMISSION_REPOSITORY = Symbol('EMPLOYEE_PERMISSION_REPOSITORY');

export interface GrantEmployeePermissionInput {
  employeeId: string;
  permissionKey: string;
  scopeType: ScopeType;
  scopeId: string | null;
  grantedBy: string;
  reason: string;
  expiresAt: Date | null;
}

/** The row a grant left behind, how it got there, and the expired row it replaced (when it did). */
export interface GrantEmployeePermissionResult {
  grant: EmployeePermission;
  outcome: GrantOutcome;
  previous: EmployeePermission | null;
}

export interface IEmployeePermissionRepository {
  /** Every direct grant the employee holds, newest first, expired ones included. */
  listForEmployee(employeeId: string): Promise<EmployeePermission[]>;
  findById(id: string): Promise<EmployeePermission | null>;
  /**
   * Grants a permission, idempotently. A live row for the same (permission, scope) is returned as it is; an
   * expired one is renewed in place with the new expiry, reason and grantor (the unique indexes allow one row
   * per scope, and an expired row confers nothing, so it must not stand in for a fresh grant).
   */
  grant(
    input: GrantEmployeePermissionInput,
    tx?: DbExecutor,
  ): Promise<GrantEmployeePermissionResult>;
  revoke(id: string, tx?: DbExecutor): Promise<void>;
}
