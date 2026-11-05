import { Injectable } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import { InjectDrizzle, type DrizzleDB, type DbExecutor } from '@platform';
import type { Permission, GroupWithPermissions } from '@platform';
import { newId } from '@shared-kernel';
import { permissions, groupPermissions, groups } from '../../../../../../db/schema';
import type { CreateGroupInput, IGroupRepository } from '../../domain/ports/group.repository';

type GroupRow = typeof groups.$inferSelect;

@Injectable()
export class GroupDrizzleRepository implements IGroupRepository {
  constructor(@InjectDrizzle() private readonly db: DrizzleDB) {}

  private toDomain(row: GroupRow, perms: string[]): GroupWithPermissions {
    return {
      id: row.id,
      key: row.key,
      name: row.name,
      system: row.system,
      updatedAt: row.updatedAt,
      permissions: perms,
    };
  }

  async list(): Promise<GroupWithPermissions[]> {
    const [groupRows, permRows] = await Promise.all([
      this.db.select().from(groups).orderBy(asc(groups.key)),
      this.db.select().from(groupPermissions),
    ]);
    const byGroup = new Map<string, string[]>();
    for (const p of permRows) {
      const list = byGroup.get(p.groupId) ?? [];
      list.push(p.permissionKey);
      byGroup.set(p.groupId, list);
    }
    return groupRows.map((r) => this.toDomain(r, byGroup.get(r.id) ?? []));
  }

  async findById(id: string): Promise<GroupWithPermissions | null> {
    const [row] = await this.db.select().from(groups).where(eq(groups.id, id)).limit(1);
    if (!row) return null;
    return this.toDomain(row, await this.permsFor(id));
  }

  async findByKey(key: string): Promise<GroupWithPermissions | null> {
    const [row] = await this.db.select().from(groups).where(eq(groups.key, key)).limit(1);
    if (!row) return null;
    return this.toDomain(row, await this.permsFor(row.id));
  }

  private async permsFor(groupId: string): Promise<string[]> {
    const rows = await this.db
      .select({ key: groupPermissions.permissionKey })
      .from(groupPermissions)
      .where(eq(groupPermissions.groupId, groupId));
    return rows.map((r) => r.key);
  }

  async create(input: CreateGroupInput, outer?: DbExecutor): Promise<GroupWithPermissions> {
    // A SAVEPOINT when the caller already has a transaction: the group row and its permission rows still
    // go in together, and the caller's audit entry joins the same unit of work.
    return (outer ?? this.db).transaction(async (tx) => {
      const [row] = await tx
        .insert(groups)
        .values({ id: newId(), key: input.key, name: input.name, system: false })
        .returning();
      if (input.permissions.length > 0) {
        await tx
          .insert(groupPermissions)
          .values(input.permissions.map((permissionKey) => ({ groupId: row.id, permissionKey })));
      }
      return this.toDomain(row, input.permissions);
    });
  }

  async setPermissions(
    groupId: string,
    permissionKeys: string[],
    outer?: DbExecutor,
  ): Promise<void> {
    await (outer ?? this.db).transaction(async (tx) => {
      await tx.delete(groupPermissions).where(eq(groupPermissions.groupId, groupId));
      if (permissionKeys.length > 0) {
        await tx
          .insert(groupPermissions)
          .values(permissionKeys.map((permissionKey) => ({ groupId: groupId, permissionKey })));
      }
      await tx.update(groups).set({ updatedAt: new Date() }).where(eq(groups.id, groupId));
    });
  }

  async delete(groupId: string, tx?: DbExecutor): Promise<void> {
    await (tx ?? this.db).delete(groups).where(eq(groups.id, groupId));
  }

  async listPermissions(): Promise<Permission[]> {
    return this.db.select().from(permissions).orderBy(asc(permissions.key));
  }
}
