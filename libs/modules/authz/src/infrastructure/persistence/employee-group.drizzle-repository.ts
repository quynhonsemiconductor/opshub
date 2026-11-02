import { Injectable } from '@nestjs/common';
import { and, desc, eq, gt, isNull, or } from 'drizzle-orm';
import { InjectDrizzle, type DrizzleDB, type DbExecutor } from '@platform';
import type { EmployeeGroup } from '@platform';
import { newId } from '@shared-kernel';
import { employees, groups, employeeGroups } from '../../../../../../db/schema';
import type {
  AssignGroupInput,
  IEmployeeGroupRepository,
} from '../../domain/ports/employee-group.repository';

type EmployeeGroupRow = typeof employeeGroups.$inferSelect;

@Injectable()
export class EmployeeGroupDrizzleRepository implements IEmployeeGroupRepository {
  constructor(@InjectDrizzle() private readonly db: DrizzleDB) {}

  private toDomain(row: EmployeeGroupRow): EmployeeGroup {
    return {
      id: row.id,
      employeeId: row.employeeId,
      groupId: row.groupId,
      scopeType: row.scopeType,
      scopeId: row.scopeId,
      grantedBy: row.grantedBy,
      expiresAt: row.expiresAt,
      createdAt: row.createdAt,
    };
  }

  async listForEmployee(employeeId: string): Promise<EmployeeGroup[]> {
    const rows = await this.db
      .select()
      .from(employeeGroups)
      .where(eq(employeeGroups.employeeId, employeeId))
      .orderBy(desc(employeeGroups.createdAt), desc(employeeGroups.id));
    return rows.map((r) => this.toDomain(r));
  }

  async listEmployeeIdsForGroup(groupId: string): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ employeeId: employeeGroups.employeeId })
      .from(employeeGroups)
      .where(eq(employeeGroups.groupId, groupId));
    return rows.map((r) => r.employeeId);
  }

  async findById(id: string): Promise<EmployeeGroup | null> {
    const [row] = await this.db
      .select()
      .from(employeeGroups)
      .where(eq(employeeGroups.id, id))
      .limit(1);
    return row ? this.toDomain(row) : null;
  }

  async assign(input: AssignGroupInput, tx?: DbExecutor): Promise<EmployeeGroup> {
    // Check-then-insert: the unique index guards non-null scopes, but Postgres
    // treats NULL scope_id as distinct, so global grants need an explicit check.
    const existing = await this.findEquivalent(input);
    if (existing) return existing;

    const [row] = await (tx ?? this.db)
      .insert(employeeGroups)
      .values({
        id: newId(),
        employeeId: input.employeeId,
        groupId: input.groupId,
        scopeType: input.scopeType,
        scopeId: input.scopeId,
        grantedBy: input.grantedBy,
        expiresAt: input.expiresAt,
      })
      .returning();
    return this.toDomain(row);
  }

  private async findEquivalent(input: AssignGroupInput): Promise<EmployeeGroup | null> {
    const [row] = await this.db
      .select()
      .from(employeeGroups)
      .where(
        and(
          eq(employeeGroups.employeeId, input.employeeId),
          eq(employeeGroups.groupId, input.groupId),
          eq(employeeGroups.scopeType, input.scopeType),
          input.scopeId === null
            ? isNull(employeeGroups.scopeId)
            : eq(employeeGroups.scopeId, input.scopeId),
        ),
      )
      .limit(1);
    return row ? this.toDomain(row) : null;
  }

  async revoke(id: string, tx?: DbExecutor): Promise<void> {
    await (tx ?? this.db).delete(employeeGroups).where(eq(employeeGroups.id, id));
  }

  async syncEmployeeGroupKeys(employeeId: string): Promise<string[]> {
    // Distinct active (non-expired) group keys for this user.
    const rows = await this.db
      .selectDistinct({ key: groups.key })
      .from(employeeGroups)
      .innerJoin(groups, eq(groups.id, employeeGroups.groupId))
      .where(
        and(
          eq(employeeGroups.employeeId, employeeId),
          or(isNull(employeeGroups.expiresAt), gt(employeeGroups.expiresAt, new Date())),
        ),
      );
    const keys = rows.map((r) => r.key).sort();
    await this.db
      .update(employees)
      .set({ groupKeys: keys, updatedAt: new Date() })
      .where(eq(employees.id, employeeId));
    return keys;
  }
}
