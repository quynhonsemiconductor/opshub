import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { InjectDrizzle, type DbExecutor, type DrizzleDB, searchAcross } from '@platform';
import { newId } from '@shared-kernel';
import { employeePositions, positions } from '../../../../../../db/schema';
import type { IPositionsRepository } from '../../domain/ports/positions.repository';
import type {
  CreatePositionInput,
  EmployeePosition,
  EmployeePositionWithRole,
  Position,
  PositionFilters,
  PositionOccupancy,
} from '../../domain/positions.types';

@Injectable()
export class PositionsDrizzleRepository implements IPositionsRepository {
  constructor(@InjectDrizzle() private readonly db: DrizzleDB) {}

  // ── Positions ────────────────────────────────────────────────────────────────

  async create(input: CreatePositionInput, tx?: DbExecutor): Promise<Position> {
    const [row] = await (tx ?? this.db)
      .insert(positions)
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

  async findById(id: string, tx?: DbExecutor): Promise<Position | null> {
    const [row] = await (tx ?? this.db)
      .select()
      .from(positions)
      .where(eq(positions.id, id))
      .limit(1);
    return row ?? null;
  }

  async findByCode(code: string): Promise<Position | null> {
    const [row] = await this.db.select().from(positions).where(eq(positions.code, code)).limit(1);
    return row ?? null;
  }

  async list(
    filters: PositionFilters,
    limit: number,
    offset: number,
  ): Promise<{ rows: PositionOccupancy[]; total: number }> {
    /**
     * Occupancy is counted in a SECOND query and merged, not with a correlated subquery.
     *
     * The subquery version returned 0 for every position while the identical SQL run by hand
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
      // types when they are looking for a position.
      searchAcross(filters.search, positions.title, positions.code, positions.department),
      filters.department ? eq(positions.department, filters.department) : undefined,
      filters.status ? eq(positions.status, filters.status) : undefined,
    );

    const rows = await this.db
      .select()
      .from(positions)
      .where(where)
      // `code` is unique; `id` is the tiebreaker the ordering ratchet can verify from source text.
      .orderBy(asc(positions.code), asc(positions.id))
      .limit(limit)
      .offset(offset);

    const [{ count }] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(positions)
      .where(where);

    const filledByPosition = new Map<string, number>();
    if (rows.length > 0) {
      const counts = await this.db
        .select({
          positionId: employeePositions.positionId,
          filled: sql<number>`count(*)::int`,
        })
        .from(employeePositions)
        .where(
          and(
            inArray(
              employeePositions.positionId,
              rows.map((r) => r.id),
            ),
            isNull(employeePositions.effectiveTo),
          ),
        )
        .groupBy(employeePositions.positionId);
      for (const c of counts) filledByPosition.set(c.positionId, c.filled);
    }

    const occupancy: PositionOccupancy[] = rows.map((r) => {
      const filled = filledByPosition.get(r.id) ?? 0;
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
      Pick<Position, 'title' | 'department' | 'rankId' | 'headcount' | 'description' | 'status'>
    >,
    tx?: DbExecutor,
  ): Promise<Position | null> {
    const [row] = await (tx ?? this.db)
      .update(positions)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(positions.id, id))
      .returning();
    return row ?? null;
  }

  // ── Assignments ──────────────────────────────────────────────────────────────

  async countOpenAssignments(positionId: string, tx?: DbExecutor): Promise<number> {
    const [row] = await (tx ?? this.db)
      .select({ count: sql<number>`count(*)::int` })
      .from(employeePositions)
      .where(
        and(eq(employeePositions.positionId, positionId), isNull(employeePositions.effectiveTo)),
      );
    return row?.count ?? 0;
  }

  async findCurrentAssignment(
    employeeId: string,
    tx?: DbExecutor,
  ): Promise<EmployeePosition | null> {
    const [row] = await (tx ?? this.db)
      .select()
      .from(employeePositions)
      .where(
        and(eq(employeePositions.employeeId, employeeId), isNull(employeePositions.effectiveTo)),
      )
      .limit(1);
    return row ?? null;
  }

  async findAssignmentById(id: string, tx?: DbExecutor): Promise<EmployeePosition | null> {
    const [row] = await (tx ?? this.db)
      .select()
      .from(employeePositions)
      .where(eq(employeePositions.id, id))
      .limit(1);
    return row ?? null;
  }

  async assign(
    input: { employeeId: string; positionId: string; effectiveFrom: string },
    tx?: DbExecutor,
  ): Promise<EmployeePosition> {
    const [row] = await (tx ?? this.db)
      .insert(employeePositions)
      .values({
        id: newId(),
        employeeId: input.employeeId,
        positionId: input.positionId,
        effectiveFrom: input.effectiveFrom,
      })
      .returning();
    return row;
  }

  async endAssignment(
    id: string,
    input: { effectiveTo: string; endReason?: string | null },
    tx?: DbExecutor,
  ): Promise<EmployeePosition | null> {
    const [row] = await (tx ?? this.db)
      .update(employeePositions)
      .set({ effectiveTo: input.effectiveTo, endReason: input.endReason ?? null })
      // Open ONLY, in the WHERE clause: closing an already-closed assignment would otherwise
      // silently rewrite its end date, and a read-then-write check could be raced.
      .where(and(eq(employeePositions.id, id), isNull(employeePositions.effectiveTo)))
      .returning();
    return row ?? null;
  }

  /**
   * One employee's history, WITH the role each row refers to.
   *
   * The join is here rather than in a second call because the caller may hold no `position.read`: this
   * powers `/positions/me`, which is self-scoped, and a bare `positionId` is unresolvable to that caller.
   * `positions` is the owning row of a non-null FK, so the inner join drops nothing.
   */
  async listAssignmentsForEmployee(employeeId: string): Promise<EmployeePositionWithRole[]> {
    return this.db
      .select({
        id: employeePositions.id,
        employeeId: employeePositions.employeeId,
        positionId: employeePositions.positionId,
        effectiveFrom: employeePositions.effectiveFrom,
        effectiveTo: employeePositions.effectiveTo,
        endReason: employeePositions.endReason,
        createdAt: employeePositions.createdAt,
        positionCode: positions.code,
        positionTitle: positions.title,
      })
      .from(employeePositions)
      .innerJoin(positions, eq(positions.id, employeePositions.positionId))
      .where(eq(employeePositions.employeeId, employeeId))
      .orderBy(desc(employeePositions.effectiveFrom), asc(employeePositions.id));
  }

  async listAssignmentsForPosition(positionId: string): Promise<EmployeePosition[]> {
    return this.db
      .select()
      .from(employeePositions)
      .where(eq(employeePositions.positionId, positionId))
      .orderBy(desc(employeePositions.effectiveFrom), asc(employeePositions.id));
  }
}
