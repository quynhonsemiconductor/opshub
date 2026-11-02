import type { DbExecutor } from '@platform';
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
} from '../training.types';

export const TRAINING_REPOSITORY = Symbol('TRAINING_REPOSITORY');

export interface ITrainingRepository {
  // ── Courses ────────────────────────────────────────────────────────────────
  createCourse(input: CreateCourseInput, tx?: DbExecutor): Promise<TrainingCourse>;
  findCourseById(id: string, tx?: DbExecutor): Promise<TrainingCourse | null>;
  findCourseByCode(code: string): Promise<TrainingCourse | null>;
  listCourses(
    filters: CourseFilters,
    limit: number,
    offset: number,
  ): Promise<{ rows: TrainingCourse[]; total: number }>;
  updateCourse(
    id: string,
    input: UpdateCourseInput,
    tx?: DbExecutor,
  ): Promise<TrainingCourse | null>;
  /** Retire a course. Returns null when it was already retired — the guard is in the WHERE. */
  retireCourse(id: string, tx?: DbExecutor): Promise<TrainingCourse | null>;

  // ── Requirements ───────────────────────────────────────────────────────────
  addRequirement(
    input: {
      roleId: string;
      courseId: string;
      kind: RequirementKind;
      graceDays?: number | null;
    },
    tx?: DbExecutor,
  ): Promise<TrainingRequirement>;
  findRequirement(roleId: string, courseId: string): Promise<TrainingRequirement | null>;
  removeRequirement(id: string, tx?: DbExecutor): Promise<TrainingRequirement | null>;
  listRequirementsForRole(roleId: string): Promise<
    (TrainingRequirement & {
      courseCode: string;
      courseTitle: string;
    })[]
  >;

  // ── Records ────────────────────────────────────────────────────────────────
  /**
   * Insert a completion. `id` may be supplied because the predecessor has to be pointed at this
   * row before it exists — see `uq_training_record_current`.
   */
  createRecord(
    input: RecordCompletionInput & { expiresOn: string | null; id?: string },
    tx?: DbExecutor,
  ): Promise<TrainingRecord>;
  findRecordById(id: string, tx?: DbExecutor): Promise<TrainingRecord | null>;
  /**
   * The live record for one (employee, course), if any.
   *
   * Takes `tx` because recording a retraining has to read it INSIDE the transaction that supersedes
   * it — read on the pool and two concurrent completions both believe the slot is free, leaving
   * `uq_training_record_current` to answer with a 500 instead of a domain error.
   */
  findCurrentRecord(
    employeeId: string,
    courseId: string,
    tx?: DbExecutor,
  ): Promise<TrainingRecord | null>;
  listRecords(
    filters: RecordFilters,
    limit: number,
    offset: number,
  ): Promise<{ rows: TrainingRecord[]; total: number }>;
  listRecordsForEmployee(employeeId: string): Promise<TrainingRecord[]>;
  /** Guarded status move, `from` in the WHERE clause so a race is Postgres's decision. */
  transitionRecord(
    id: string,
    from: TrainingRecord['status'],
    to: TrainingRecord['status'],
    extra: Partial<
      Pick<TrainingRecord, 'revokedReason' | 'supersededById' | 'verifiedBy' | 'verifiedAt'>
    >,
    tx?: DbExecutor,
  ): Promise<TrainingRecord | null>;
  /** Point a superseded record at its replacement without touching its status. */
  linkSuccessor(id: string, successorId: string, tx?: DbExecutor): Promise<void>;
  markVerified(id: string, verifiedBy: string, tx?: DbExecutor): Promise<TrainingRecord | null>;

  // ── The report ─────────────────────────────────────────────────────────────
  /**
   * Mandatory courses an employee's CURRENT role requires and they do not hold.
   *
   * One query, not a loop: the gap report is the whole point of modelling requirements on the
   * role, and computing it per employee in TypeScript would be an N+1 over the org chart.
   */
  competencyGaps(input: {
    employeeId?: string;
    roleId?: string;
    asOf: string;
    includeRecommended: boolean;
  }): Promise<CompetencyGap[]>;
}
