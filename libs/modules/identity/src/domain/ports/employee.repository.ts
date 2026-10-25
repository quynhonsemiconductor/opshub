import type { DbExecutor } from '@platform';
import type {
  CreateEmployeeInput,
  UpdateEmployeeInput,
  Employee,
  EmployeeFilters,
  EmployeeStatus,
} from '../employee.types';

export const EMPLOYEE_REPOSITORY = Symbol('EMPLOYEE_REPOSITORY');

/**
 * Every MUTATION takes an optional `tx`, so its audit entry can share the same transaction.
 *
 * Reads deliberately do not: a read inside the caller's transaction sees the same rows either way, and
 * threading `tx` through them would be noise around the one thing that matters — a change and the entry
 * describing it committing together, or not at all.
 */
export interface IEmployeeRepository {
  create(input: CreateEmployeeInput, tx?: DbExecutor): Promise<Employee>;
  findById(id: string): Promise<Employee | null>;
  /**
   * Which of these ids exist, in one query.
   *
   * For validating a REFERENCE rather than reading a person: thirty-four call sites called `findById`
   * through the service and threw the result away, one round trip per id, purely for the throw.
   */
  findExistingIds(ids: string[]): Promise<string[]>;
  findByEmail(email: string): Promise<Employee | null>;
  findByEntraOid(oid: string): Promise<Employee | null>;
  list(
    filters: EmployeeFilters,
    limit: number,
    offset: number,
  ): Promise<{ rows: Employee[]; total: number }>;
  update(id: string, input: UpdateEmployeeInput, tx?: DbExecutor): Promise<Employee>;
  updateStatus(id: string, status: EmployeeStatus, tx?: DbExecutor): Promise<Employee>;
  /** Update the S3 object key for the employee’s profile photo. Pass null to clear. */
  updatePhoto(id: string, photoStorageKey: string | null, tx?: DbExecutor): Promise<void>;
}
