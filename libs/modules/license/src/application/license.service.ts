import { Inject, Injectable } from '@nestjs/common';
import {
  ConflictException,
  NotFoundException,
  PreconditionFailedException,
  ErrorCodes,
  InjectDrizzle,
  nameOf,
  resolveEmployeeNames,
  type DrizzleDB,
} from '@platform';
import { type Actor } from '@shared-kernel';
import {
  AuditService,
  AUDIT_ACTION,
  AUDIT_RESOURCE,
  type ResourceAuditTrail,
} from '@modules/audit';
import { LICENSE_REPOSITORY, type ILicenseRepository } from '../domain/ports/license.repository';
import type {
  SoftwareLicense,
  LicenseAssignment,
  LicenseUtilization,
  CreateLicenseInput,
  UpdateLicenseInput,
  LicenseFilters,
} from '../domain/license.types';

/**
 * Software licences and their seats.
 *
 * AUDIT ENTRIES SHARE THEIR MUTATION'S TRANSACTION. Every write here was fire-and-forget, and two of them
 * matter more than most: a licence DELETE, where the entry is the only remaining record it existed, and a seat
 * assignment, which is the row a true-up reconciles against a vendor invoice.
 */
@Injectable()
export class LicenseService {
  private readonly licenseTrail: ResourceAuditTrail;
  private readonly seatTrail: ResourceAuditTrail;

  constructor(
    @Inject(LICENSE_REPOSITORY) private readonly repo: ILicenseRepository,
    @InjectDrizzle() private readonly db: DrizzleDB,
    audit: AuditService,
  ) {
    this.licenseTrail = audit.forResource(AUDIT_RESOURCE.SOFTWARE_LICENSE);
    this.seatTrail = audit.forResource(AUDIT_RESOURCE.LICENSE_ASSIGNMENT);
  }

  async create(input: CreateLicenseInput, actor: Actor): Promise<SoftwareLicense> {
    return this.db.transaction(async (tx) => {
      const license = await this.repo.create(input, tx);
      await this.licenseTrail.record(AUDIT_ACTION.LICENSE_CREATED, license.id, actor, tx, {
        after: { name: license.name, vendor: license.vendor },
      });
      return license;
    });
  }

  async getById(id: string): Promise<SoftwareLicense> {
    const license = await this.repo.findById(id);
    if (!license) throw new NotFoundException(ErrorCodes.NOT_FOUND, 'License not found');
    return license;
  }

  async list(
    filters: LicenseFilters,
    limit: number,
    offset: number,
  ): Promise<{ rows: SoftwareLicense[]; total: number }> {
    return this.repo.list(filters, limit, offset);
  }

  async update(id: string, input: UpdateLicenseInput, actor: Actor): Promise<SoftwareLicense> {
    await this.getById(id);
    return this.db.transaction(async (tx) => {
      const updated = await this.repo.update(id, input, tx);
      if (!updated) throw new NotFoundException(ErrorCodes.NOT_FOUND, 'License not found');
      await this.licenseTrail.record(AUDIT_ACTION.LICENSE_UPDATED, id, actor, tx, {
        after: input,
      });
      return updated;
    });
  }

  async delete(id: string, actor: Actor): Promise<void> {
    await this.getById(id);
    const usedSeats = await this.repo.countActiveSeats(id);
    if (usedSeats > 0) {
      throw new PreconditionFailedException(
        ErrorCodes.PRECONDITION_FAILED,
        `Cannot delete license with ${usedSeats} active assignment(s). Revoke all seats first.`,
      );
    }
    // A hard delete: the entry is the only record the licence ever existed.
    await this.db.transaction(async (tx) => {
      await this.repo.delete(id, tx);
      await this.licenseTrail.record(AUDIT_ACTION.LICENSE_DELETED, id, actor, tx, {});
    });
  }

  async assign(
    licenseId: string,
    employeeId: string,
    notes: string | null,
    actor: Actor,
  ): Promise<LicenseAssignment> {
    const license = await this.getById(licenseId);

    const existing = await this.repo.findActiveAssignment(licenseId, employeeId);
    if (existing) {
      throw new ConflictException(
        ErrorCodes.CONFLICT,
        'Employee already has an active seat for this license',
      );
    }

    if (license.seatCount != null) {
      const used = await this.repo.countActiveSeats(licenseId);
      if (used >= license.seatCount) {
        throw new PreconditionFailedException(
          ErrorCodes.PRECONDITION_FAILED,
          'No seats available for this license',
        );
      }
    }

    return this.db.transaction(async (tx) => {
      const assignment = await this.repo.assign(licenseId, employeeId, notes, tx);
      await this.seatTrail.record(AUDIT_ACTION.LICENSE_SEAT_ASSIGNED, assignment.id, actor, tx, {
        after: { licenseId, employeeId },
      });
      return assignment;
    });
  }

  async revoke(assignmentId: string, actor: Actor): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.repo.revoke(assignmentId, tx);
      await this.seatTrail.record(AUDIT_ACTION.LICENSE_SEAT_REVOKED, assignmentId, actor, tx, {});
    });
  }

  async listAssignments(
    licenseId: string,
    includeRevoked = false,
  ): Promise<(LicenseAssignment & { employeeName: string | null })[]> {
    await this.getById(licenseId);
    const rows = await this.repo.listAssignments(licenseId, includeRevoked);
    /*
     * WHO HOLDS THE SEAT, by name.
     *
     * This list is opened to make one decision — whose seat to reclaim — and a uuid per line cannot
     * support it. The list is not a directory of people who happen to have a licence; it is a bill,
     * and every active row is money going out every month, so "is Mai still using this" is the only
     * question asked of it.
     *
     * One query for the whole list. Names resolved on the server because `GET /v1/employees` needs
     * `employee.read`, and the tier that manages licences is `license.manage` — IT_ADMIN happens to
     * hold both, but a finance-shaped role granted only the licence bundle would have got a 403 and
     * a panel of dashes, which is the state this replaces.
     *
     * A left lookup rather than a join, and that matters more here than most: a REVOKED seat held by
     * somebody who has since left is exactly the row a vendor true-up reconciles against an invoice,
     * and a join would delete the evidence along with the person.
     */
    const names = await resolveEmployeeNames(
      this.db,
      rows.map((r) => r.employeeId),
    );
    return rows.map((r) => ({ ...r, employeeName: nameOf(names, r.employeeId) }));
  }

  async getUtilization(): Promise<LicenseUtilization[]> {
    return this.repo.getUtilization();
  }
}
