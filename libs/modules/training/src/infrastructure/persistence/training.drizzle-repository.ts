import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gte, isNotNull, isNull, lt, lte, ne, or, sql } from 'drizzle-orm';
import { InjectDrizzle, type DbExecutor, type DrizzleDB } from '@platform';
import { newId, toIsoDate } from '@shared-kernel';
import {
  employeePositions,
  trainingCourses,
  trainingPositionRequirements,
  trainingRecords,
} from '../../../../../../db/schema';
import type { ITrainingRepository } from '../../domain/ports/training.repository';
import type {
  CompetencyGap,
  CourseFilters,
  CreateCourseInput,
  RecordCompletionInput,
  RecordFilters,
  RequirementKind,
  TrainingCourse,
  TrainingRecord,
  TrainingRequirement,
  UpdateCourseInput,
} from '../../domain/training.types';

/**
 * `expired` IS DERIVED, not stored — and until now it was neither.
 *
 * `training_records.status` defaults to `valid` and the only other value ever written is `revoked`:
 * nothing in the codebase, and no job, ever writes `expired`. But the list endpoint filtered on the
 * stored column, so the Records tab's "Expired" chip sent `status=expired`, matched no row, and told
 * the reader "no training records match these filters". Anybody asking "who has lapsed?" was answered
 * "nobody", while the competency-gap report on the next tab correctly reported the same people as
 * gaps. Two tabs, contradictory answers, and the reassuring one was wrong.
 *
 * The index on `(status, expires_on)` shows the derived read was always the intent.
 *
 * A record is expired when it is otherwise valid and its expiry date has passed. `revoked` outranks
 * it: a revoked certificate is not "expired", it was taken away, and that distinction is the whole
 * point of having both.
 */
function effectiveStatus(
  status: TrainingRecord['status'],
  expiresOn: string | null,
  today: string,
): TrainingRecord['status'] {
  if (status !== 'valid' || !expiresOn) return status;
  // `YYYY-MM-DD` compared as strings: in that format lexicographic order IS chronological order, so
  // there is no parsing and no timezone in the comparison.
  return expiresOn < today ? 'expired' : status;
}

/**
 * The SQL for a status filter, given that one of the three values is not in the column.
 *
 * `expired` becomes "valid, and lapsed"; `valid` has to exclude the lapsed ones or the two filters
 * would return overlapping sets and the counts would not add up.
 */
function statusFilter(status: TrainingRecord['status'], today: string) {
  if (status === 'expired') {
    return and(
      eq(trainingRecords.status, 'valid'),
      isNotNull(trainingRecords.expiresOn),
      lt(trainingRecords.expiresOn, today),
    );
  }
  if (status === 'valid') {
    return and(
      eq(trainingRecords.status, 'valid'),
      or(isNull(trainingRecords.expiresOn), gte(trainingRecords.expiresOn, today)),
    );
  }
  return eq(trainingRecords.status, status);
}

@Injectable()
export class TrainingDrizzleRepository implements ITrainingRepository {
  constructor(@InjectDrizzle() private readonly db: DrizzleDB) {}

  // ── Courses ──────────────────────────────────────────────────────────────────

  async createCourse(input: CreateCourseInput, tx?: DbExecutor): Promise<TrainingCourse> {
    const [row] = await (tx ?? this.db)
      .insert(trainingCourses)
      .values({
        id: newId(),
        code: input.code,
        title: input.title,
        category: input.category,
        provider: input.provider ?? null,
        description: input.description ?? null,
        validityMonths: input.validityMonths ?? null,
      })
      .returning();
    return row;
  }

  async findCourseById(id: string, tx?: DbExecutor): Promise<TrainingCourse | null> {
    const [row] = await (tx ?? this.db)
      .select()
      .from(trainingCourses)
      .where(eq(trainingCourses.id, id))
      .limit(1);
    return row ?? null;
  }

  async findCourseByCode(code: string): Promise<TrainingCourse | null> {
    const [row] = await this.db
      .select()
      .from(trainingCourses)
      .where(eq(trainingCourses.code, code))
      .limit(1);
    return row ?? null;
  }

  async listCourses(
    filters: CourseFilters,
    limit: number,
    offset: number,
  ): Promise<{ rows: TrainingCourse[]; total: number }> {
    const where = and(
      filters.category ? eq(trainingCourses.category, filters.category) : undefined,
      filters.includeRetired ? undefined : isNull(trainingCourses.retiredAt),
    );

    const rows = await this.db
      .select()
      .from(trainingCourses)
      .where(where)
      // `code` is unique; `id` is the tiebreaker the ordering ratchet can verify from source text.
      .orderBy(asc(trainingCourses.code), asc(trainingCourses.id))
      .limit(limit)
      .offset(offset);

    const [{ count }] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(trainingCourses)
      .where(where);

    return { rows, total: count };
  }

  async updateCourse(
    id: string,
    input: UpdateCourseInput,
    tx?: DbExecutor,
  ): Promise<TrainingCourse | null> {
    const [row] = await (tx ?? this.db)
      .update(trainingCourses)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(trainingCourses.id, id))
      .returning();
    return row ?? null;
  }

  async retireCourse(id: string, tx?: DbExecutor): Promise<TrainingCourse | null> {
    const [row] = await (tx ?? this.db)
      .update(trainingCourses)
      .set({ retiredAt: new Date(), updatedAt: new Date() })
      // Not-yet-retired only: retiring twice would rewrite the date, and a read-then-write check
      // could be raced.
      .where(and(eq(trainingCourses.id, id), isNull(trainingCourses.retiredAt)))
      .returning();
    return row ?? null;
  }

  // ── Requirements ─────────────────────────────────────────────────────────────

  async addRequirement(
    input: {
      positionId: string;
      courseId: string;
      kind: RequirementKind;
      graceDays?: number | null;
    },
    tx?: DbExecutor,
  ): Promise<TrainingRequirement> {
    const [row] = await (tx ?? this.db)
      .insert(trainingPositionRequirements)
      .values({
        id: newId(),
        positionId: input.positionId,
        courseId: input.courseId,
        kind: input.kind,
        graceDays: input.graceDays ?? null,
      })
      .returning();
    return row;
  }

  async findRequirement(positionId: string, courseId: string): Promise<TrainingRequirement | null> {
    const [row] = await this.db
      .select()
      .from(trainingPositionRequirements)
      .where(
        and(
          eq(trainingPositionRequirements.positionId, positionId),
          eq(trainingPositionRequirements.courseId, courseId),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async removeRequirement(id: string, tx?: DbExecutor): Promise<TrainingRequirement | null> {
    const [row] = await (tx ?? this.db)
      .delete(trainingPositionRequirements)
      .where(eq(trainingPositionRequirements.id, id))
      .returning();
    return row ?? null;
  }

  async listRequirementsForPosition(
    positionId: string,
  ): Promise<(TrainingRequirement & { courseCode: string; courseTitle: string })[]> {
    return this.db
      .select({
        id: trainingPositionRequirements.id,
        positionId: trainingPositionRequirements.positionId,
        courseId: trainingPositionRequirements.courseId,
        kind: trainingPositionRequirements.kind,
        graceDays: trainingPositionRequirements.graceDays,
        createdAt: trainingPositionRequirements.createdAt,
        courseCode: trainingCourses.code,
        courseTitle: trainingCourses.title,
      })
      .from(trainingPositionRequirements)
      .innerJoin(trainingCourses, eq(trainingCourses.id, trainingPositionRequirements.courseId))
      .where(eq(trainingPositionRequirements.positionId, positionId))
      .orderBy(asc(trainingCourses.code), asc(trainingPositionRequirements.id));
  }

  // ── Records ──────────────────────────────────────────────────────────────────

  async createRecord(
    input: RecordCompletionInput & { expiresOn: string | null; id?: string },
    tx?: DbExecutor,
  ): Promise<TrainingRecord> {
    const [row] = await (tx ?? this.db)
      .insert(trainingRecords)
      .values({
        // The caller may mint the id: superseding the previous record has to point at this row
        // BEFORE it exists, because the partial unique index forbids two current rows at once.
        id: input.id ?? newId(),
        employeeId: input.employeeId,
        courseId: input.courseId,
        completedOn: input.completedOn,
        expiresOn: input.expiresOn,
        result: input.result ?? null,
        score: input.score ?? null,
        notes: input.notes ?? null,
      })
      .returning();
    return row;
  }

  async findRecordById(id: string, tx?: DbExecutor): Promise<TrainingRecord | null> {
    const [row] = await (tx ?? this.db)
      .select()
      .from(trainingRecords)
      .where(eq(trainingRecords.id, id))
      .limit(1);
    return row ?? null;
  }

  async findCurrentRecord(
    employeeId: string,
    courseId: string,
    tx?: DbExecutor,
  ): Promise<TrainingRecord | null> {
    const [row] = await (tx ?? this.db)
      .select()
      .from(trainingRecords)
      .where(
        and(
          eq(trainingRecords.employeeId, employeeId),
          eq(trainingRecords.courseId, courseId),
          // The same predicate as `uq_training_record_current`, so this read and that index agree
          // on what "current" means.
          isNull(trainingRecords.supersededById),
          ne(trainingRecords.status, 'revoked'),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async listRecords(
    filters: RecordFilters,
    limit: number,
    offset: number,
  ): Promise<{ rows: TrainingRecord[]; total: number }> {
    const where = and(
      filters.employeeId ? eq(trainingRecords.employeeId, filters.employeeId) : undefined,
      filters.courseId ? eq(trainingRecords.courseId, filters.courseId) : undefined,
      filters.status ? statusFilter(filters.status, toIsoDate(new Date())) : undefined,
      filters.currentOnly ? isNull(trainingRecords.supersededById) : undefined,
      // The renewal queue: only a live record can lapse, so the status is implied by the filter
      // rather than left to the caller to remember.
      filters.expiringOnOrBefore
        ? and(
            eq(trainingRecords.status, 'valid'),
            isNull(trainingRecords.supersededById),
            lte(trainingRecords.expiresOn, filters.expiringOnOrBefore),
          )
        : undefined,
    );

    const rows = await this.db
      .select()
      .from(trainingRecords)
      .where(where)
      .orderBy(desc(trainingRecords.completedOn), asc(trainingRecords.id))
      .limit(limit)
      .offset(offset);

    const [{ count }] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(trainingRecords)
      .where(where);

    /*
     * The row has to SAY expired, not merely be findable by the filter. The Status column rendered
     * "Valid" on a certificate whose expiry passed years ago — so the register disagreed with the gap
     * report about the same person, and the reassuring answer was the one on screen.
     */
    const today = toIsoDate(new Date());
    return {
      rows: rows.map((r) => ({ ...r, status: effectiveStatus(r.status, r.expiresOn, today) })),
      total: count,
    };
  }

  async listRecordsForEmployee(employeeId: string): Promise<TrainingRecord[]> {
    const rows = await this.db
      .select()
      .from(trainingRecords)
      .where(eq(trainingRecords.employeeId, employeeId))
      .orderBy(desc(trainingRecords.completedOn), asc(trainingRecords.id));
    /*
     * The employee's own list derives it too — this is the screen most of the company sees, and its
     * "Current certificates" tile counts what this returns.
     *
     * NOT `findRecordById`, deliberately. That one is the guard every write path calls, and
     * `transitionRecord` matches on the STORED status: handing it a derived `expired` would make
     * verifying or revoking a lapsed certificate fail to match any row. The distinction is between a
     * value being READ and a value being WRITTEN FROM.
     */
    const today = toIsoDate(new Date());
    return rows.map((r) => ({ ...r, status: effectiveStatus(r.status, r.expiresOn, today) }));
  }

  async transitionRecord(
    id: string,
    from: TrainingRecord['status'],
    to: TrainingRecord['status'],
    extra: Partial<
      Pick<TrainingRecord, 'revokedReason' | 'supersededById' | 'verifiedBy' | 'verifiedAt'>
    >,
    tx?: DbExecutor,
  ): Promise<TrainingRecord | null> {
    const [row] = await (tx ?? this.db)
      .update(trainingRecords)
      .set({ status: to, ...extra, updatedAt: new Date() })
      // The FROM state is in the WHERE clause: two concurrent callers would both pass a
      // read-then-write, and only one can win an UPDATE.
      .where(and(eq(trainingRecords.id, id), eq(trainingRecords.status, from)))
      .returning();
    return row ?? null;
  }

  async linkSuccessor(id: string, successorId: string, tx?: DbExecutor): Promise<void> {
    await (tx ?? this.db)
      .update(trainingRecords)
      .set({ supersededById: successorId, updatedAt: new Date() })
      // Only if still unlinked, so a second retraining cannot rewrite which record replaced this
      // one.
      .where(and(eq(trainingRecords.id, id), isNull(trainingRecords.supersededById)));
  }

  async markVerified(
    id: string,
    verifiedBy: string,
    tx?: DbExecutor,
  ): Promise<TrainingRecord | null> {
    const [row] = await (tx ?? this.db)
      .update(trainingRecords)
      .set({ verifiedBy, verifiedAt: new Date(), updatedAt: new Date() })
      // Unverified only: verifying twice would overwrite who attested and when, which is the one
      // fact an ISO competency audit actually reads.
      .where(and(eq(trainingRecords.id, id), isNull(trainingRecords.verifiedBy)))
      .returning();
    return row ?? null;
  }

  // ── The report ───────────────────────────────────────────────────────────────

  /**
   * The competency gap report, as ONE query.
   *
   * Reads each employee's CURRENT position from `positions.employee_positions` — the open
   * assignment — rather than a copy on the record, so a transfer changes what somebody needs
   * without any backfill. Left-joins the live record for each required course; a NULL means never
   * completed, a past `expires_on` means lapsed, and both are reported with the reason because the
   * remedy differs.
   */
  async competencyGaps(input: {
    employeeId?: string;
    positionId?: string;
    asOf: string;
    includeRecommended: boolean;
  }): Promise<CompetencyGap[]> {
    const rows = await this.db
      .select({
        employeeId: employeePositions.employeeId,
        positionId: trainingPositionRequirements.positionId,
        courseId: trainingPositionRequirements.courseId,
        courseCode: trainingCourses.code,
        courseTitle: trainingCourses.title,
        kind: trainingPositionRequirements.kind,
        graceDays: trainingPositionRequirements.graceDays,
        recordId: trainingRecords.id,
        completedOn: trainingRecords.completedOn,
        expiresOn: trainingRecords.expiresOn,
      })
      .from(employeePositions)
      .innerJoin(
        trainingPositionRequirements,
        eq(trainingPositionRequirements.positionId, employeePositions.positionId),
      )
      .innerJoin(trainingCourses, eq(trainingCourses.id, trainingPositionRequirements.courseId))
      .leftJoin(
        trainingRecords,
        and(
          eq(trainingRecords.employeeId, employeePositions.employeeId),
          eq(trainingRecords.courseId, trainingPositionRequirements.courseId),
          isNull(trainingRecords.supersededById),
          ne(trainingRecords.status, 'revoked'),
        ),
      )
      .where(
        and(
          // The CURRENT assignment only — a course required by a role somebody left is not a gap.
          isNull(employeePositions.effectiveTo),
          // A retired course cannot be a gap: nobody can be sent on it.
          isNull(trainingCourses.retiredAt),
          input.employeeId ? eq(employeePositions.employeeId, input.employeeId) : undefined,
          input.positionId
            ? eq(trainingPositionRequirements.positionId, input.positionId)
            : undefined,
          input.includeRecommended ? undefined : eq(trainingPositionRequirements.kind, 'mandatory'),
          // A gap is: no live record at all, OR one that has lapsed by `asOf`.
          or(
            isNull(trainingRecords.id),
            and(eq(trainingRecords.status, 'valid'), lte(trainingRecords.expiresOn, input.asOf)),
            eq(trainingRecords.status, 'expired'),
          ),
        ),
      )
      .orderBy(
        asc(employeePositions.employeeId),
        asc(trainingCourses.code),
        asc(trainingPositionRequirements.id),
      );

    return rows.map((r) => ({
      ...r,
      reason: r.recordId === null ? ('never_completed' as const) : ('expired' as const),
    }));
  }
}
