import { Injectable } from '@nestjs/common';
import { and, desc, eq, gt, isNull, or } from 'drizzle-orm';
import { InjectDrizzle, type DrizzleDB, type DbExecutor } from '@platform';
import type { RoleAssignment } from '@platform';
import { newId } from '@shared-kernel';
import { employees, groups, employeeGroups } from '../../../../../../db/schema';
import type {
  AssignRoleInput,
  IRoleAssignmentRepository,
} from '../../domain/ports/role-assignment.repository';

type AssignmentRow = typeof employeeGroups.$inferSelect;

@Injectable()
export class RoleAssignmentDrizzleRepository implements IRoleAssignmentRepository {
  constructor(@InjectDrizzle() private readonly db: DrizzleDB) {}

  private toDomain(row: AssignmentRow): RoleAssignment {
    return {
      id: row.id,
      userId: row.employeeId,
      roleId: row.groupId,
      scopeType: row.scopeType,
      scopeId: row.scopeId,
      grantedBy: row.grantedBy,
      expiresAt: row.expiresAt,
      createdAt: row.createdAt,
    };
  }

  async listForUser(userId: string): Promise<RoleAssignment[]> {
    const rows = await this.db
      .select()
      .from(employeeGroups)
      .where(eq(employeeGroups.employeeId, userId))
      .orderBy(desc(employeeGroups.createdAt), desc(employeeGroups.id));
    return rows.map((r) => this.toDomain(r));
  }

  async listUserIdsForRole(roleId: string): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ userId: employeeGroups.employeeId })
      .from(employeeGroups)
      .where(eq(employeeGroups.groupId, roleId));
    return rows.map((r) => r.userId);
  }

  async findById(id: string): Promise<RoleAssignment | null> {
    const [row] = await this.db
      .select()
      .from(employeeGroups)
      .where(eq(employeeGroups.id, id))
      .limit(1);
    return row ? this.toDomain(row) : null;
  }

  async assign(input: AssignRoleInput, tx?: DbExecutor): Promise<RoleAssignment> {
    // Check-then-insert: the unique index guards non-null scopes, but Postgres
    // treats NULL scope_id as distinct, so global grants need an explicit check.
    const existing = await this.findEquivalent(input);
    if (existing) return existing;

    const [row] = await (tx ?? this.db)
      .insert(employeeGroups)
      .values({
        id: newId(),
        employeeId: input.userId,
        groupId: input.roleId,
        scopeType: input.scopeType,
        scopeId: input.scopeId,
        grantedBy: input.grantedBy,
        expiresAt: input.expiresAt,
      })
      .returning();
    return this.toDomain(row);
  }

  private async findEquivalent(input: AssignRoleInput): Promise<RoleAssignment | null> {
    const [row] = await this.db
      .select()
      .from(employeeGroups)
      .where(
        and(
          eq(employeeGroups.employeeId, input.userId),
          eq(employeeGroups.groupId, input.roleId),
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

  async syncEmployeeRoleClaims(userId: string): Promise<string[]> {
    // Distinct active (non-expired) role keys for this user.
    const rows = await this.db
      .selectDistinct({ key: groups.key })
      .from(employeeGroups)
      .innerJoin(groups, eq(groups.id, employeeGroups.groupId))
      .where(
        and(
          eq(employeeGroups.employeeId, userId),
          or(isNull(employeeGroups.expiresAt), gt(employeeGroups.expiresAt, new Date())),
        ),
      );
    const keys = rows.map((r) => r.key).sort();
    await this.db
      .update(employees)
      .set({ groupKeys: keys, updatedAt: new Date() })
      .where(eq(employees.id, userId));
    return keys;
  }
}
