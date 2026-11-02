import type { DbExecutor, EmployeePermission, ScopeType } from '@platform';

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

export interface IEmployeePermissionRepository {
  /** Every direct grant the employee holds, newest first, expired ones included. */
  listForEmployee(employeeId: string): Promise<EmployeePermission[]>;
  findById(id: string): Promise<EmployeePermission | null>;
  /** Idempotent grant: returns the existing row when the same (permission, scope) is already held. */
  grant(input: GrantEmployeePermissionInput, tx?: DbExecutor): Promise<EmployeePermission>;
  revoke(id: string, tx?: DbExecutor): Promise<void>;
}
