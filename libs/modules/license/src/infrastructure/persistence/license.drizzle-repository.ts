import { Injectable } from '@nestjs/common';
import { and, asc, count, desc, eq, isNull, sql } from 'drizzle-orm';
import { InjectDrizzle, type DrizzleDB, type DbExecutor, searchAcross } from '@platform';
import { newId } from '@shared-kernel';
import { softwareLicenses, licenseAssignments } from '../../../../../../db/schema';
import type { ILicenseRepository } from '../../domain/ports/license.repository';
import type {
  SoftwareLicense,
  LicenseAssignment,
  LicenseUtilization,
  CreateLicenseInput,
  UpdateLicenseInput,
  LicenseFilters,
} from '../../domain/license.types';

@Injectable()
export class LicenseDrizzleRepository implements ILicenseRepository {
  constructor(@InjectDrizzle() private readonly db: DrizzleDB) {}

  async create(input: CreateLicenseInput, tx?: DbExecutor): Promise<SoftwareLicense> {
    const [row] = await (tx ?? this.db)
      .insert(softwareLicenses)
      .values({
        id: newId(),
        name: input.name,
        vendor: input.vendor,
        vendorId: input.vendorId ?? null,
        licenseType: input.licenseType,
        seatCount: input.seatCount ?? null,
        costPerSeatCents: input.costPerSeatCents ?? null,
        renewalDate: input.renewalDate ?? null,
        notes: input.notes ?? null,
        externalId: input.externalId ?? null,
      })
      .returning();
    return row;
  }

  async findById(id: string): Promise<SoftwareLicense | null> {
    const [row] = await this.db
      .select()
      .from(softwareLicenses)
      .where(eq(softwareLicenses.id, id))
      .limit(1);
    return row ?? null;
  }

  async list(
    filters: LicenseFilters,
    limit: number,
    offset: number,
  ): Promise<{ rows: SoftwareLicense[]; total: number }> {
    const conditions = [
      filters.status ? eq(softwareLicenses.status, filters.status) : undefined,
      searchAcross(filters.vendor, softwareLicenses.vendor),
      searchAcross(filters.search, softwareLicenses.name),
    ].filter(Boolean);

    const where = conditions.length ? and(...conditions) : undefined;

    const [rows, [countRow]] = await Promise.all([
      /*
       * ORDERED, because it is PAGED. This was the only `.offset()` in the codebase with no
       * `ORDER BY` at all: Postgres is free to return rows in any order it likes, and it changes
       * that order as the plan changes, so paging repeated the same licence on page 2 and dropped
       * another entirely. Nothing errors and the totals still add up, which is why it survived.
       *
       * `desc(createdAt), desc(id)` is the shape every other paged list here uses, and the `id`
       * tiebreaker is what makes the order TOTAL — two licences created in the same transaction
       * share a timestamp, and without it their relative order is again arbitrary.
       */
      this.db
        .select()
        .from(softwareLicenses)
        .where(where)
        .orderBy(desc(softwareLicenses.createdAt), desc(softwareLicenses.id))
        .limit(limit)
        .offset(offset),
      this.db.select({ total: count() }).from(softwareLicenses).where(where),
    ]);

    return { rows, total: countRow?.total ?? 0 };
  }

  async update(
    id: string,
    input: UpdateLicenseInput,
    tx?: DbExecutor,
  ): Promise<SoftwareLicense | null> {
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (input.name !== undefined) patch['name'] = input.name;
    if (input.vendor !== undefined) patch['vendor'] = input.vendor;
    if (input.vendorId !== undefined) patch['vendorId'] = input.vendorId;
    if (input.licenseType !== undefined) patch['licenseType'] = input.licenseType;
    if ('seatCount' in input) patch['seatCount'] = input.seatCount;
    if ('costPerSeatCents' in input) patch['costPerSeatCents'] = input.costPerSeatCents;
    if ('renewalDate' in input) patch['renewalDate'] = input.renewalDate;
    if (input.status !== undefined) patch['status'] = input.status;
    if ('notes' in input) patch['notes'] = input.notes;
    if ('externalId' in input) patch['externalId'] = input.externalId;

    const [row] = await (tx ?? this.db)
      .update(softwareLicenses)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
      .set(patch as any)
      .where(eq(softwareLicenses.id, id))
      .returning();
    return row ?? null;
  }

  async delete(id: string, tx?: DbExecutor): Promise<void> {
    await (tx ?? this.db).delete(softwareLicenses).where(eq(softwareLicenses.id, id));
  }

  async assign(
    licenseId: string,
    employeeId: string,
    notes: string | null,
    tx?: DbExecutor,
  ): Promise<LicenseAssignment> {
    const [row] = await (tx ?? this.db)
      .insert(licenseAssignments)
      .values({ id: newId(), licenseId, employeeId, notes })
      .returning();
    return row;
  }

  async revoke(assignmentId: string, tx?: DbExecutor): Promise<void> {
    await (tx ?? this.db)
      .update(licenseAssignments)
      .set({ revokedAt: new Date() })
      .where(eq(licenseAssignments.id, assignmentId));
  }

  async listAssignments(licenseId: string, includeRevoked: boolean): Promise<LicenseAssignment[]> {
    const conditions = [eq(licenseAssignments.licenseId, licenseId)];
    if (!includeRevoked) conditions.push(isNull(licenseAssignments.revokedAt));
    return (
      this.db
        .select()
        .from(licenseAssignments)
        .where(and(...conditions))
        // Unpaged, so nothing was being LOST here — but the order was still whatever the scan
        // produced, so the seat list reshuffled between two loads of the same screen.
        .orderBy(desc(licenseAssignments.assignedAt), desc(licenseAssignments.id))
    );
  }

  async findActiveAssignment(
    licenseId: string,
    employeeId: string,
  ): Promise<LicenseAssignment | null> {
    const [row] = await this.db
      .select()
      .from(licenseAssignments)
      .where(
        and(
          eq(licenseAssignments.licenseId, licenseId),
          eq(licenseAssignments.employeeId, employeeId),
          isNull(licenseAssignments.revokedAt),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async countActiveSeats(licenseId: string): Promise<number> {
    const [row] = await this.db
      .select({ n: count() })
      .from(licenseAssignments)
      .where(
        and(eq(licenseAssignments.licenseId, licenseId), isNull(licenseAssignments.revokedAt)),
      );
    return row?.n ?? 0;
  }

  async getUtilization(): Promise<LicenseUtilization[]> {
    const rows = await this.db
      .select({
        licenseId: softwareLicenses.id,
        name: softwareLicenses.name,
        vendor: softwareLicenses.vendor,
        status: softwareLicenses.status,
        seatCount: softwareLicenses.seatCount,
        costPerSeatCents: softwareLicenses.costPerSeatCents,
        usedSeats: sql<number>`count(${licenseAssignments.id}) filter (where ${licenseAssignments.revokedAt} is null)`,
      })
      .from(softwareLicenses)
      .leftJoin(licenseAssignments, eq(softwareLicenses.id, licenseAssignments.licenseId))
      .groupBy(
        softwareLicenses.id,
        softwareLicenses.name,
        softwareLicenses.vendor,
        softwareLicenses.status,
        softwareLicenses.seatCount,
        softwareLicenses.costPerSeatCents,
      )
      // By NAME, because this feeds a utilisation table somebody reads down. Unordered, the rows
      // arrived in whatever order the aggregate produced and moved between refreshes. `id` is the
      // tiebreaker for two licences of the same name, and it is a GROUP BY key, so ordering on it
      // is legal here — an aggregate may only order by its grouping keys.
      .orderBy(asc(softwareLicenses.name), asc(softwareLicenses.id));

    return rows.map((r) => {
      const used = Number(r.usedSeats);
      const available = r.seatCount != null ? r.seatCount - used : null;
      const pct =
        r.seatCount != null && r.seatCount > 0 ? Math.round((used / r.seatCount) * 100) : null;
      /*
       * TWO FIGURES, NAMED FOR WHAT THEY ARE. There used to be one, called `monthlySpendCents`, and it
       * was `used * cost` — the cost of the occupied seats. The FinOps tile summed it and called it
       * "Monthly spend" while the table two inches below computed `seatCount * cost` from the same
       * row, so the screen disagreed with itself; on the seeded register the tile showed about six per
       * cent of the committed figure, and the licences with the most idle seats contributed least to
       * it.
       *
       * Committed is what an invoice says. Assigned is what is being used. The gap is the number
       * somebody acts on, and it was the one thing the page could not show.
       */
      const committed =
        r.costPerSeatCents != null && r.seatCount != null ? r.seatCount * r.costPerSeatCents : null;
      const assigned = r.costPerSeatCents != null ? used * r.costPerSeatCents : null;
      return {
        licenseId: r.licenseId,
        name: r.name,
        vendor: r.vendor,
        status: r.status,
        seatCount: r.seatCount,
        usedSeats: used,
        availableSeats: available,
        utilizationPct: pct,
        committedSpendCents: committed,
        assignedSpendCents: assigned,
      };
    });
  }
}
