import { Injectable } from '@nestjs/common';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { InjectDrizzle, type DbExecutor, type DrizzleDB, type EmployeePermission } from '@platform';
import { newId } from '@shared-kernel';
import { employeePermissions } from '../../../../../../db/schema';
import type {
  GrantEmployeePermissionInput,
  IEmployeePermissionRepository,
} from '../../domain/ports/employee-permission.repository';

type EmployeePermissionRow = typeof employeePermissions.$inferSelect;

@Injectable()
export class EmployeePermissionDrizzleRepository implements IEmployeePermissionRepository {
  constructor(@InjectDrizzle() private readonly db: DrizzleDB) {}

  private toDomain(row: EmployeePermissionRow): EmployeePermission {
    return {
      id: row.id,
      employeeId: row.employeeId,
      permissionKey: row.permissionKey,
      scopeType: row.scopeType,
      scopeId: row.scopeId,
      grantedBy: row.grantedBy,
      reason: row.reason,
      expiresAt: row.expiresAt,
      createdAt: row.createdAt,
    };
  }

  async listForEmployee(employeeId: string): Promise<EmployeePermission[]> {
    const rows = await this.db
      .select()
      .from(employeePermissions)
      .where(eq(employeePermissions.employeeId, employeeId))
      .orderBy(desc(employeePermissions.createdAt), desc(employeePermissions.id));
    return rows.map((row) => this.toDomain(row));
  }

  async findById(id: string): Promise<EmployeePermission | null> {
    const [row] = await this.db
      .select()
      .from(employeePermissions)
      .where(eq(employeePermissions.id, id))
      .limit(1);
    return row ? this.toDomain(row) : null;
  }

  async grant(input: GrantEmployeePermissionInput, tx?: DbExecutor): Promise<EmployeePermission> {
    // Check-then-insert: the unique indexes guard each scope shape, but a global grant has a NULL scope id,
    // which Postgres treats as distinct, so the equivalent row is looked up explicitly.
    const existing = await this.findEquivalent(input);
    if (existing) return existing;

    const [row] = await (tx ?? this.db)
      .insert(employeePermissions)
      .values({
        id: newId(),
        employeeId: input.employeeId,
        permissionKey: input.permissionKey,
        scopeType: input.scopeType,
        scopeId: input.scopeId,
        grantedBy: input.grantedBy,
        reason: input.reason,
        expiresAt: input.expiresAt,
      })
      .returning();
    return this.toDomain(row);
  }

  private async findEquivalent(
    input: GrantEmployeePermissionInput,
  ): Promise<EmployeePermission | null> {
    const [row] = await this.db
      .select()
      .from(employeePermissions)
      .where(
        and(
          eq(employeePermissions.employeeId, input.employeeId),
          eq(employeePermissions.permissionKey, input.permissionKey),
          eq(employeePermissions.scopeType, input.scopeType),
          input.scopeId === null
            ? isNull(employeePermissions.scopeId)
            : eq(employeePermissions.scopeId, input.scopeId),
        ),
      )
      .limit(1);
    return row ? this.toDomain(row) : null;
  }

  async revoke(id: string, tx?: DbExecutor): Promise<void> {
    await (tx ?? this.db).delete(employeePermissions).where(eq(employeePermissions.id, id));
  }
}
