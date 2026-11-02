import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { InjectDrizzle, type DbExecutor, type DrizzleDB, searchAcross } from '@platform';
import { newId } from '@shared-kernel';
import { employeeRoles, roles } from '../../../../../../db/schema';
import type { IRolesRepository } from '../../domain/ports/roles.repository';
import type {
  CreateRoleInput,
  EmployeeRole,
  EmployeeRoleWithDetails,
  Role,
  RoleFilters,
  RoleOccupancy,
} from '../../domain/roles.types';

@Injectable()
export class RolesDrizzleRepository implements IRolesRepository {
  constructor(@InjectDrizzle() private readonly db: DrizzleDB) {}

  // ── Roles ────────────────────────────────────────────────────────────────

  async create(input: CreateRoleInput, tx?: DbExecutor): Promise<Role> {
    const [row] = await (tx ?? this.db)
      .insert(roles)
      .values({
        id: newId(),
        code: input.code,
        title: input.title,
        department: input.department,
        rankId: input.rankId ?? null,
        headcount: input.headcount ?? 1,
        description: input.description ?? null,
      })
      .returning();
    return row;
  }

  async findById(id: string, tx?: DbExecutor): Promise<Role | null> {
    const [row] = await (tx ?? this.db).select().from(roles).where(eq(roles.id, id)).limit(1);
    return row ?? null;
  }

  async findByCode(code: string): Promise<Role | null> {
    const [row] = await this.db.select().from(roles).where(eq(roles.code, code)).limit(1);
    return row ?? null;
  }

  async list(
    filters: RoleFilters,
    limit: number,
    offset: number,
  ): Promise<{ rows: RoleOccupancy[]; total: number }> {
    /**
     * Occupancy is counted in a SECOND query and merged, not with a correlated subquery.
     *
     * The subquery version returned 0 for every role while the identical SQL run by hand
     * returned the right counts — a rendering problem in the template, and not one worth debugging
     * when the alternative is this. Two queries per page is not an N+1: the second is a single
     * GROUP BY over the page's ids.
     *
     * `vacantOnly` therefore has to filter AFTER the counts are known, which is why it is applied
     * in TypeScript below rather than in the WHERE clause. The cost is that `total` counts before
     * that filter — documented on the route, and preferable to a filter that can disagree with the
     * number displayed next to it.
     */
    const where = and(
      // The SPA had a search box before this existed, and the parameter was simply dropped — a control
      // that looks like it filters and does not. Title, code and department, which is what somebody
      // types when they are looking for a role.
      searchAcross(filters.search, roles.title, roles.code, roles.department),
      filters.department ? eq(roles.department, filters.department) : undefined,
      filters.status ? eq(roles.status, filters.status) : undefined,
    );

    const rows = await this.db
      .select()
      .from(roles)
      .where(where)
      // `code` is unique; `id` is the tiebreaker the ordering ratchet can verify from source text.
      .orderBy(asc(roles.code), asc(roles.id))
      .limit(limit)
      .offset(offset);

    const [{ count }] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(roles)
      .where(where);

    const filledByRole = new Map<string, number>();
    if (rows.length > 0) {
      const counts = await this.db
        .select({
          roleId: employeeRoles.roleId,
          filled: sql<number>`count(*)::int`,
        })
        .from(employeeRoles)
        .where(
          and(
            inArray(
              employeeRoles.roleId,
              rows.map((r) => r.id),
            ),
            isNull(employeeRoles.effectiveTo),
          ),
        )
        .groupBy(employeeRoles.roleId);
      for (const c of counts) filledByRole.set(c.roleId, c.filled);
    }

    const occupancy: RoleOccupancy[] = rows.map((r) => {
      const filled = filledByRole.get(r.id) ?? 0;
      return {
        ...r,
        filled,
        // Floored at zero: reducing an approved headcount below current occupancy is a real
        // restructure, and reporting −2 vacancies would be nonsense on a hiring screen.
        vacancies: Math.max(0, r.headcount - filled),
      };
    });

    return {
      rows: filters.vacantOnly ? occupancy.filter((p) => p.vacancies > 0) : occupancy,
      total: count,
    };
  }

  async update(
    id: string,
    input: Partial<
      Pick<Role, 'title' | 'department' | 'rankId' | 'headcount' | 'description' | 'status'>
    >,
    tx?: DbExecutor,
  ): Promise<Role | null> {
    const [row] = await (tx ?? this.db)
      .update(roles)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(roles.id, id))
      .returning();
    return row ?? null;
  }

  // ── Assignments ──────────────────────────────────────────────────────────────

  async countOpenAssignments(roleId: string, tx?: DbExecutor): Promise<number> {
    const [row] = await (tx ?? this.db)
      .select({ count: sql<number>`count(*)::int` })
      .from(employeeRoles)
      .where(and(eq(employeeRoles.roleId, roleId), isNull(employeeRoles.effectiveTo)));
    return row?.count ?? 0;
  }

  async findCurrentAssignment(employeeId: string, tx?: DbExecutor): Promise<EmployeeRole | null> {
    const [row] = await (tx ?? this.db)
      .select()
      .from(employeeRoles)
      .where(and(eq(employeeRoles.employeeId, employeeId), isNull(employeeRoles.effectiveTo)))
      .limit(1);
    return row ?? null;
  }

  async findAssignmentById(id: string, tx?: DbExecutor): Promise<EmployeeRole | null> {
    const [row] = await (tx ?? this.db)
      .select()
      .from(employeeRoles)
      .where(eq(employeeRoles.id, id))
      .limit(1);
    return row ?? null;
  }

  async assign(
    input: { employeeId: string; roleId: string; effectiveFrom: string },
    tx?: DbExecutor,
  ): Promise<EmployeeRole> {
    const [row] = await (tx ?? this.db)
      .insert(employeeRoles)
      .values({
        id: newId(),
        employeeId: input.employeeId,
        roleId: input.roleId,
        effectiveFrom: input.effectiveFrom,
      })
      .returning();
    return row;
  }

  async endAssignment(
    id: string,
    input: { effectiveTo: string; endReason?: string | null },
    tx?: DbExecutor,
  ): Promise<EmployeeRole | null> {
    const [row] = await (tx ?? this.db)
      .update(employeeRoles)
      .set({ effectiveTo: input.effectiveTo, endReason: input.endReason ?? null })
      // Open ONLY, in the WHERE clause: closing an already-closed assignment would otherwise
      // silently rewrite its end date, and a read-then-write check could be raced.
      .where(and(eq(employeeRoles.id, id), isNull(employeeRoles.effectiveTo)))
      .returning();
    return row ?? null;
  }

  /**
   * One employee's history, WITH the role each row refers to.
   *
   * The join is here rather than in a second call because the caller may hold no `role.read`: this
   * powers `/roles/me`, which is self-scoped, and a bare `roleId` is unresolvable to that caller.
   * `roles` is the owning row of a non-null FK, so the inner join drops nothing.
   */
  async listAssignmentsForEmployee(employeeId: string): Promise<EmployeeRoleWithDetails[]> {
    return this.db
      .select({
        id: employeeRoles.id,
        employeeId: employeeRoles.employeeId,
        roleId: employeeRoles.roleId,
        effectiveFrom: employeeRoles.effectiveFrom,
        effectiveTo: employeeRoles.effectiveTo,
        endReason: employeeRoles.endReason,
        createdAt: employeeRoles.createdAt,
        roleCode: roles.code,
        roleTitle: roles.title,
      })
      .from(employeeRoles)
      .innerJoin(roles, eq(roles.id, employeeRoles.roleId))
      .where(eq(employeeRoles.employeeId, employeeId))
      .orderBy(desc(employeeRoles.effectiveFrom), asc(employeeRoles.id));
  }

  async listAssignmentsForRole(roleId: string): Promise<EmployeeRole[]> {
    return this.db
      .select()
      .from(employeeRoles)
      .where(eq(employeeRoles.roleId, roleId))
      .orderBy(desc(employeeRoles.effectiveFrom), asc(employeeRoles.id));
  }
}
