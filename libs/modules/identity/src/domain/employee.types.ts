import type { employeeStatusEnum } from '../../../../../db/schema';

export type EmployeeStatus = (typeof employeeStatusEnum.enumValues)[number];

export interface Employee {
  id: string;
  entraOid: string | null;
  email: string;
  displayName: string;
  department: string | null;
  jobTitle: string | null;
  managerId: string | null;
  /** Keys of the permission groups the employee belongs to — a cache of `authz.employee_groups`. */
  groupKeys: string[];
  status: EmployeeStatus;
  /** S3 object key for the profile photo; null until an avatar is uploaded. */
  photoStorageKey: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateEmployeeInput {
  email: string;
  displayName: string;
  department?: string | null;
  jobTitle?: string | null;
  managerId?: string | null;
  /**
   * Only set by the Entra SSO JIT-provisioning path (the group keys named by the
   * token's App Role claim). The directory/employee HTTP endpoints never set this —
   * group membership is governed by the authz module.
   */
  groupKeys?: string[];
  entraOid?: string | null;
}

export interface UpdateEmployeeInput {
  displayName?: string;
  department?: string | null;
  jobTitle?: string | null;
  managerId?: string | null;
}

export interface EmployeeFilters {
  status?: EmployeeStatus;
  department?: string;
  search?: string;
}
