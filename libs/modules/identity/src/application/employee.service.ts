import { Inject, Injectable } from '@nestjs/common';
import {
  NotFoundException,
  ConflictException,
  ErrorCodes,
  InjectDrizzle,
  StorageService,
  type DrizzleDB,
} from '@platform';
import { AuthTokenCache } from '@quynhonsemiconductor/identity';
import type { PresignUploadResult } from '@platform';
import { SEC_PER_DAY } from '@shared-kernel';
import {
  AuditService,
  AUDIT_ACTION,
  AUDIT_RESOURCE,
  type ResourceAuditTrail,
} from '@modules/audit';
import { EMPLOYEE_REPOSITORY, type IEmployeeRepository } from '../domain/ports/employee.repository';
import {
  REFRESH_TOKEN_REPOSITORY,
  type IRefreshTokenRepository,
} from '../domain/ports/refresh-token.repository';
import type {
  CreateEmployeeInput,
  UpdateEmployeeInput,
  Employee,
  EmployeeFilters,
  EmployeeStatus,
} from '../domain/employee.types';

/** Actor passed from controllers to service mutations for audit logging. */
export interface Actor {
  sub: string;
  email: string;
}

/**
 * Employees, and the sessions that follow from their status.
 *
 * EVERY AUDIT ENTRY SHARES ITS MUTATION'S TRANSACTION. These calls used to be
 * a fire-and-forget `audit.record` call: outside any transaction, with the failure swallowed, so an employee could
 * be created, renamed or offboarded with nothing in the trail and nothing anywhere saying so. The entry now
 * commits with the row or not at all.
 *
 * WHAT STAYS OUTSIDE THE TRANSACTION, deliberately: revoking sessions in Valkey and deleting an old avatar
 * from S3. Neither can be rolled back by Postgres, so holding them inside a transaction would buy nothing and
 * would keep the row locked across a network call. They run after it commits, in the order that fails safe —
 * revoking a session for a change that did not happen is recoverable; the reverse is not.
 */
@Injectable()
export class EmployeeService {
  private readonly trail: ResourceAuditTrail;

  constructor(
    @Inject(EMPLOYEE_REPOSITORY) private readonly employeeRepo: IEmployeeRepository,
    @Inject(REFRESH_TOKEN_REPOSITORY) private readonly refreshTokenRepo: IRefreshTokenRepository,
    private readonly authCache: AuthTokenCache,
    private readonly storage: StorageService,
    @InjectDrizzle() private readonly db: DrizzleDB,
    audit: AuditService,
  ) {
    this.trail = audit.forResource(AUDIT_RESOURCE.EMPLOYEE);
  }

  async create(input: CreateEmployeeInput, actor: Actor): Promise<Employee> {
    const existing = await this.employeeRepo.findByEmail(input.email.toLowerCase());
    if (existing) {
      throw new ConflictException(ErrorCodes.CONFLICT, `Employee ${input.email} already exists`);
    }
    return this.db.transaction(async (tx) => {
      const employee = await this.employeeRepo.create(
        { ...input, email: input.email.toLowerCase() },
        tx,
      );
      await this.trail.record(AUDIT_ACTION.EMPLOYEE_CREATED, employee.id, actor, tx, {
        after: {
          email: employee.email,
          displayName: employee.displayName,
          roles: employee.roles,
        },
      });
      return employee;
    });
  }

  async getById(id: string): Promise<Employee> {
    const employee = await this.employeeRepo.findById(id);
    if (!employee) throw new NotFoundException(ErrorCodes.EMPLOYEE_NOT_FOUND, 'Employee not found');
    return employee;
  }

  /**
   * Refuse unless every id given names a real employee.
   *
   * WHAT THIS REPLACED. Thirty-four call sites wrote `await this.employees.getById(dto.ownerId);` and
   * discarded the result — a full row fetched, an object built, nothing read from it. The call existed
   * only to throw, and nothing in it said so: a reader sees an awaited expression with no left-hand
   * side and has to know that `getById` throws to understand the line is a guard at all. Twelve of
   * them wrapped it in `if (dto.ownerId)` to skip an optional field, so the guard's shape differed
   * depending on whether the column was nullable.
   *
   * WHY THIS IS LOAD-BEARING and not a nicety: these are CROSS-SCHEMA references, and by deliberate
   * design they carry no foreign key (`isms.information_assets.owner_id` says so in migration 0022).
   * The database will not catch a dangling owner. This check is the only thing that does.
   *
   * NULLISH IDS ARE SKIPPED, so an optional field needs no `if` around the call and a caller can pass
   * every reference it has in one line. Passing nothing is not an error — it means there was nothing
   * to check.
   *
   * ONE QUERY, and it names the ids that were missing. The old form fetched one row per reference and
   * failed on the first, so a form with a bad owner AND a bad custodian told the user about one of
   * them, and the next submit failed on the other.
   */
  async assertExist(...ids: (string | null | undefined)[]): Promise<void> {
    const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))];
    if (wanted.length === 0) return;

    const found = new Set(await this.employeeRepo.findExistingIds(wanted));
    const missing = wanted.filter((id) => !found.has(id));
    if (missing.length > 0) {
      throw new NotFoundException(
        ErrorCodes.EMPLOYEE_NOT_FOUND,
        // Plural on purpose: which reference is wrong is the whole content of this failure.
        `Employee not found: ${missing.join(', ')}`,
      );
    }
  }

  async update(id: string, input: UpdateEmployeeInput, actor: Actor): Promise<Employee> {
    const employee = await this.employeeRepo.findById(id);
    if (!employee) throw new NotFoundException(ErrorCodes.EMPLOYEE_NOT_FOUND, 'Employee not found');

    return this.db.transaction(async (tx) => {
      const updated = await this.employeeRepo.update(id, input, tx);
      await this.trail.record(AUDIT_ACTION.EMPLOYEE_UPDATED, id, actor, tx, { after: input });
      return updated;
    });
  }

  /**
   * Change employee status.
   * - Offboarding: immediately revokes all active refresh token sessions AND
   *   fast-revokes outstanding access tokens via the shared AuthTokenCache
   *   user-revocation denylist.
   * - Re-activating: clears the revocation entry so the employee can log in again.
   */
  async updateStatus(id: string, status: EmployeeStatus, actor: Actor): Promise<Employee> {
    const employee = await this.employeeRepo.findById(id);
    if (!employee) throw new NotFoundException(ErrorCodes.EMPLOYEE_NOT_FOUND, 'Employee not found');
    if (employee.status === status) return employee;

    const updated = await this.db.transaction(async (tx) => {
      const row = await this.employeeRepo.updateStatus(id, status, tx);
      await this.trail.record(AUDIT_ACTION.EMPLOYEE_STATUS_CHANGED, id, actor, tx, {
        before: { status: employee.status },
        after: { status },
      });
      return row;
    });

    // AFTER the commit, and outside it: Valkey and the session table cannot be rolled back with the row.
    if (status === 'offboarded') {
      // Revoke all DB sessions immediately
      await this.refreshTokenRepo.revokeAllForEmployee(id);
      // Fast-revoke any live access tokens — blocks them within milliseconds
      // TTL = 24h to cover any edge cases (access tokens expire in 15 min anyway)
      await this.authCache.revokeUser(id, SEC_PER_DAY);
    } else if (status === 'active') {
      // Clear revocation if re-activating an offboarded employee
      await this.authCache.unrevokeUser(id);
    }

    return updated;
  }

  async list(
    filters: EmployeeFilters,
    limit: number,
    offset: number,
  ): Promise<{ rows: Employee[]; total: number }> {
    return this.employeeRepo.list(filters, limit, offset);
  }

  // ── Avatar ──────────────────────────────────────────────────────────────────

  /** Step 1 — returns a presigned S3 PUT URL for the client to upload to directly. */
  async presignAvatar(
    employeeId: string,
    input: { fileName: string; mimeType: string; sizeBytes: number },
    actor: Actor,
  ): Promise<PresignUploadResult> {
    await this.getById(employeeId); // 404 guard
    return this.storage.presignUpload(
      {
        fileName: input.fileName,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        resourceType: 'employee-avatar',
        linkedEntityType: 'employee',
        linkedEntityId: employeeId,
      },
      actor.sub,
    );
  }

  /** Step 3 — verify upload, link the S3 key to the employee row. */
  async confirmAvatar(
    employeeId: string,
    fileId: string,
    actor: Actor,
  ): Promise<{ avatarUrl: string }> {
    const employee = await this.getById(employeeId);
    const result = await this.storage.confirmUpload(fileId, actor.sub);

    // Soft-delete the old avatar if one exists
    if (employee.photoStorageKey) {
      // The column holds the KEY, not the file id — passing it to `findById` made every replacement
      // upload a 500.
      const old = await this.storage.findByKey(employee.photoStorageKey);
      if (old) void this.storage.deleteFile(old.id, old.uploaderId);
    }

    await this.db.transaction(async (tx) => {
      await this.employeeRepo.updatePhoto(employeeId, result.key, tx);
      await this.trail.record(AUDIT_ACTION.EMPLOYEE_AVATAR_UPDATED, employeeId, actor, tx, {});
    });

    return { avatarUrl: result.url };
  }

  /** Returns a time-limited download URL for the employee’s avatar. */
  async getAvatarUrl(employeeId: string): Promise<{ avatarUrl: string | null }> {
    const employee = await this.getById(employeeId);
    if (!employee.photoStorageKey) return { avatarUrl: null };
    const url = await this.storage.presignGet(employee.photoStorageKey);
    return { avatarUrl: url };
  }

  /** Remove the employee’s avatar from S3 and clear the column. */
  async deleteAvatar(employeeId: string, actor: Actor): Promise<void> {
    const employee = await this.getById(employeeId);
    if (!employee.photoStorageKey) return; // already none — idempotent

    const file = await this.storage.findByKey(employee.photoStorageKey);
    if (file) void this.storage.deleteFile(file.id, file.uploaderId);

    await this.db.transaction(async (tx) => {
      await this.employeeRepo.updatePhoto(employeeId, null, tx);
      await this.trail.record(AUDIT_ACTION.EMPLOYEE_AVATAR_DELETED, employeeId, actor, tx, {});
    });
  }
}
