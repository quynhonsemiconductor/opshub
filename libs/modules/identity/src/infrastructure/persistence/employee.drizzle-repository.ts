import { Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { InjectDrizzle, type DbExecutor, type DrizzleDB, searchAcross } from '@platform';
import { newId } from '@shared-kernel';
import { employees } from '../../../../../../db/schema';
import type { IEmployeeRepository } from '../../domain/ports/employee.repository';
import type {
  CreateEmployeeInput,
  UpdateEmployeeInput,
  Employee,
  EmployeeFilters,
  EmployeeStatus,
} from '../../domain/employee.types';

@Injectable()
export class EmployeeDrizzleRepository implements IEmployeeRepository {
  constructor(@InjectDrizzle() private readonly db: DrizzleDB) {}

  async create(input: CreateEmployeeInput, tx?: DbExecutor): Promise<Employee> {
    const [row] = await (tx ?? this.db)
      .insert(employees)
      .values({
        id: newId(),
        // The one choke point every create passes through: addresses are stored lower-cased.
        email: input.email.trim().toLowerCase(),
        displayName: input.displayName,
        department: input.department ?? null,
        jobTitle: input.jobTitle ?? null,
        managerId: input.managerId ?? null,
        roles: input.roles ?? [],
        entraOid: input.entraOid ?? null,
      })
      .returning();
    return row;
  }

  async findById(id: string): Promise<Employee | null> {
    const [row] = await this.db.select().from(employees).where(eq(employees.id, id)).limit(1);
    return row ?? null;
  }

  async findExistingIds(ids: string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const rows = await this.db
      .select({ id: employees.id })
      .from(employees)
      .where(inArray(employees.id, ids));
    return rows.map((row) => row.id);
  }

  async findByEmail(email: string): Promise<Employee | null> {
    const [row] = await this.db
      .select()
      .from(employees)
      .where(sql`lower(${employees.email}) = ${email.trim().toLowerCase()}`)
      .limit(1);
    return row ?? null;
  }

  async findByEntraOid(oid: string): Promise<Employee | null> {
    const [row] = await this.db
      .select()
      .from(employees)
      .where(eq(employees.entraOid, oid))
      .limit(1);
    return row ?? null;
  }

  async upsertByEntraOid(
    oid: string,
    input: Partial<import('../../domain/employee.types').CreateEmployeeInput> & {
      email: string;
      displayName: string;
    },
  ): Promise<Employee> {
    const existing = await this.findByEntraOid(oid);
    if (existing) {
      const [updated] = await this.db
        .update(employees)
        .set({
          displayName: input.displayName,
          email: input.email.toLowerCase(),
          updatedAt: new Date(),
        })
        .where(eq(employees.entraOid, oid))
        .returning();
      return updated;
    }

    const byEmail = await this.findByEmail(input.email.toLowerCase());
    if (byEmail) {
      const [linked] = await this.db
        .update(employees)
        .set({ entraOid: oid, displayName: input.displayName, updatedAt: new Date() })
        .where(eq(employees.id, byEmail.id))
        .returning();
      return linked;
    }

    return this.create({ ...input, entraOid: oid, roles: [] });
  }

  async update(id: string, input: UpdateEmployeeInput, tx?: DbExecutor): Promise<Employee> {
    const [updated] = await (tx ?? this.db)
      .update(employees)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(employees.id, id))
      .returning();
    return updated;
  }

  async updateStatus(id: string, status: EmployeeStatus, tx?: DbExecutor): Promise<Employee> {
    const [updated] = await (tx ?? this.db)
      .update(employees)
      .set({ status, updatedAt: new Date() })
      .where(eq(employees.id, id))
      .returning();
    return updated;
  }

  async list(
    filters: EmployeeFilters,
    limit: number,
    offset: number,
  ): Promise<{ rows: Employee[]; total: number }> {
    const conditions = [
      filters.status ? eq(employees.status, filters.status) : undefined,
      filters.department ? eq(employees.department, filters.department) : undefined,
      searchAcross(filters.search, employees.displayName, employees.email),
    ].filter(Boolean);
    const where = conditions.length ? and(...conditions) : undefined;

    const rows = await this.db
      .select()
      .from(employees)
      .where(where)
      .orderBy(desc(employees.createdAt), desc(employees.id))
      .limit(limit)
      .offset(offset);

    const [{ count }] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(employees)
      .where(where);

    return { rows: rows, total: count };
  }

  async updatePhoto(id: string, photoStorageKey: string | null, tx?: DbExecutor): Promise<void> {
    await (tx ?? this.db)
      .update(employees)
      .set({ photoStorageKey, updatedAt: new Date() })
      .where(eq(employees.id, id));
  }
}
