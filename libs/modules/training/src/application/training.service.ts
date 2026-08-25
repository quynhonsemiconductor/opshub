import { Inject, Injectable } from '@nestjs/common';
import {
  ConflictException,
  EntityAttachmentsService,
  ErrorCodes,
  InjectDrizzle,
  NotFoundException,
  PreconditionFailedException,
  assertDateOrder,
  nameOf,
  resolveEmployeeNames,
  type AttachmentRef,
  type DrizzleDB,
  type EntityAttachment,
} from '@platform';
import { addMonths, newId, today, type Actor, latestDateAnywhere } from '@shared-kernel';
import { AUDIT_ACTION, AUDIT_RESOURCE, AuditService } from '@modules/audit';
import { TRAINING_REPOSITORY, type ITrainingRepository } from '../domain/ports/training.repository';
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
} from '../domain/training.types';

/** The upload surface certificates land on — its policy carries the quota and the MIME set. */
const CERTIFICATE_SURFACE = 'training-certificate' as const;

/** The link table's entity type for a training record. */
const RECORD_ENTITY = 'training_record';

/**
 * Training courses, what each POSITION requires, and who has completed what.
 *
 * WHAT THIS SERVICE OWNS THAT THE DATABASE CANNOT
 *
 * 1. EXPIRY IS DERIVED ONCE. `expires_on` is computed from the course's `validity_months` at the
 *    moment of completion and then FROZEN. A CHECK cannot compute it, and computing it on read
 *    would restate every historical record the first time somebody corrected a course — the same
 *    reason a leave request freezes its working-day count at submit.
 *
 * 2. RETRAINING IS ONE ACT. A new completion supersedes the live record for that (employee, course)
 *    in a single transaction, superseding FIRST. That order is forced by
 *    `uq_training_record_current`: inserting first hits the index, which is the intended behaviour
 *    rather than an obstacle — it means "their current training" always has exactly one answer.
 *
 * 3. TRANSITIONS. Verify-once, revoke-with-a-reason, and "a retired course accepts no new
 *    completions" are rules about a CHANGE, and a CHECK cannot see the previous value. Each is also
 *    a guarded `WHERE` in the repository, so a race is decided by Postgres rather than by whoever
 *    read first.
 *
 * NO EXPIRY SWEEP, deliberately — unlike a contract. A lapsed certificate changes nothing about
 * what may happen next; it is a question about today's date, which `expiresOn <= asOf` answers in
 * the report. A nightly job would add a way for the answer to be stale and buy nothing. `revoked`
 * and `superseded` ARE stored, because those are decisions somebody made.
 */
@Injectable()
export class TrainingService {
  constructor(
    @Inject(TRAINING_REPOSITORY) private readonly repo: ITrainingRepository,
    @InjectDrizzle() private readonly db: DrizzleDB,
    private readonly audit: AuditService,
    private readonly attachments: EntityAttachmentsService,
  ) {}

  // ── Courses ──────────────────────────────────────────────────────────────────

  async createCourse(input: CreateCourseInput, actor: Actor): Promise<TrainingCourse> {
    if (await this.repo.findCourseByCode(input.code)) {
      throw new ConflictException(
        ErrorCodes.CONFLICT,
        `Course code '${input.code}' is already in use`,
      );
    }

    return this.db.transaction(async (tx) => {
      const course = await this.repo.createCourse(input, tx);
      await this.audit.recordChange(
        actor,
        AUDIT_ACTION.TRAINING_COURSE_CREATED,
        AUDIT_RESOURCE.TRAINING_COURSE,
        course.id,
        {
          after: { code: course.code, title: course.title, validityMonths: course.validityMonths },
        },
        tx,
      );
      return course;
    });
  }

  async getCourse(id: string): Promise<TrainingCourse> {
    const course = await this.repo.findCourseById(id);
    if (!course) throw new NotFoundException(ErrorCodes.NOT_FOUND, `Course ${id} not found`);
    return course;
  }

  async listCourses(filters: CourseFilters, limit: number, offset: number) {
    return this.repo.listCourses(filters, limit, offset);
  }

  /**
   * Change a course.
   *
   * Editing `validityMonths` deliberately does NOT restate existing records: their `expires_on` was
   * frozen at completion. The new value governs the next completion, which is what "we have changed
   * the rule" means — and it keeps a correction from silently making people non-compliant for a
   * period they were told they were covered.
   */
  async updateCourse(id: string, input: UpdateCourseInput, actor: Actor): Promise<TrainingCourse> {
    const before = await this.getCourse(id);

    return this.db.transaction(async (tx) => {
      const after = await this.repo.updateCourse(id, input, tx);
      await this.audit.recordChange(
        actor,
        AUDIT_ACTION.TRAINING_COURSE_UPDATED,
        AUDIT_RESOURCE.TRAINING_COURSE,
        id,
        {
          before: { title: before.title, validityMonths: before.validityMonths },
          after: { title: after!.title, validityMonths: after!.validityMonths },
        },
        tx,
      );
      return after!;
    });
  }

  /** Retire a course. Records already taken against it keep referencing it. */
  async retireCourse(id: string, actor: Actor): Promise<TrainingCourse> {
    await this.getCourse(id);

    return this.db.transaction(async (tx) => {
      const retired = await this.repo.retireCourse(id, tx);
      if (!retired) {
        throw new PreconditionFailedException(
          ErrorCodes.PRECONDITION_FAILED,
          'That course is already retired',
        );
      }
      await this.audit.recordChange(
        actor,
        AUDIT_ACTION.TRAINING_COURSE_RETIRED,
        AUDIT_RESOURCE.TRAINING_COURSE,
        id,
        {
          after: { retiredAt: retired.retiredAt },
        },
        tx,
      );
      return retired;
    });
  }

  // ── Requirements ─────────────────────────────────────────────────────────────

  async addRequirement(
    input: {
      positionId: string;
      courseId: string;
      kind?: RequirementKind;
      graceDays?: number | null;
    },
    actor: Actor,
  ): Promise<TrainingRequirement> {
    const course = await this.getCourse(input.courseId);
    if (course.retiredAt) {
      throw new PreconditionFailedException(
        ErrorCodes.PRECONDITION_FAILED,
        `Course ${course.code} is retired and cannot be required of a position`,
      );
    }
    if (await this.repo.findRequirement(input.positionId, input.courseId)) {
      throw new ConflictException(
        ErrorCodes.CONFLICT,
        `Course ${course.code} is already required for that position`,
      );
    }

    return this.db.transaction(async (tx) => {
      const requirement = await this.repo.addRequirement(
        { ...input, kind: input.kind ?? 'mandatory' },
        tx,
      );
      await this.audit.recordChange(
        actor,
        AUDIT_ACTION.TRAINING_REQUIREMENT_ADDED,
        AUDIT_RESOURCE.TRAINING_REQUIREMENT,
        requirement.id,
        {
          after: { positionId: input.positionId, courseCode: course.code, kind: requirement.kind },
        },
        tx,
      );
      return requirement;
    });
  }

  async removeRequirement(id: string, actor: Actor): Promise<void> {
    await this.db.transaction(async (tx) => {
      const removed = await this.repo.removeRequirement(id, tx);
      if (!removed) {
        throw new NotFoundException(ErrorCodes.NOT_FOUND, `Requirement ${id} not found`);
      }
      await this.audit.recordChange(
        actor,
        AUDIT_ACTION.TRAINING_REQUIREMENT_REMOVED,
        AUDIT_RESOURCE.TRAINING_REQUIREMENT,
        id,
        { before: { positionId: removed.positionId, courseId: removed.courseId } },
        tx,
      );
    });
  }

  async listRequirementsForPosition(positionId: string) {
    return this.repo.listRequirementsForPosition(positionId);
  }

  // ── Records ──────────────────────────────────────────────────────────────────

  /**
   * Record a completion, superseding whatever the employee currently holds for that course.
   *
   * One transaction: supersede, then insert, then link the predecessor forward. The order is forced
   * by `uq_training_record_current`, and the forward link is written last so it can only ever point
   * at a record that actually exists.
   */
  async recordCompletion(input: RecordCompletionInput, actor: Actor): Promise<TrainingRecord> {
    const course = await this.getCourse(input.courseId);
    if (course.retiredAt) {
      throw new PreconditionFailedException(
        ErrorCodes.PRECONDITION_FAILED,
        `Course ${course.code} is retired and accepts no new completions`,
      );
    }
    // `latestDateAnywhere`, not `today()`: the date came from a person in an unknown timezone, and UTC
    // midnight is already tomorrow for a third of the planet. See the helper for the measurement.
    if (input.completedOn > latestDateAnywhere()) {
      throw new PreconditionFailedException(
        ErrorCodes.TRAINING_INVALID_COMPLETION,
        `A completion cannot be dated in the future (${input.completedOn})`,
      );
    }

    const expiresOn =
      course.validityMonths === null ? null : addMonths(input.completedOn, course.validityMonths);
    if (expiresOn) {
      // `ck_training_record_window` stated as a domain rule. Unreachable through this path, since
      // `addMonths` with a positive validity always moves forward — but the guard is what keeps it
      // unreachable if the arithmetic ever changes.
      assertDateOrder(
        input.completedOn,
        expiresOn,
        ErrorCodes.TRAINING_INVALID_COMPLETION,
        'A certificate cannot expire before it was earned',
      );
    }

    /**
     * The successor's id is minted HERE, before the row exists.
     *
     * `uq_training_record_current` forbids two current rows for one (employee, course), so the
     * predecessor has to stop matching that predicate BEFORE the insert — and it stops matching by
     * having `superseded_by_id` set, which means pointing at a row that does not exist yet. Hence
     * the id first, the link second, the insert third.
     *
     * `superseded_by_id` therefore carries no foreign key, deliberately: within the transaction it
     * is briefly a dangling reference, and by commit it resolves. An FK would have to be
     * DEFERRABLE INITIALLY DEFERRED to allow that, which is a sharper tool than this needs.
     */
    const successorId = newId();

    return this.db.transaction(async (tx) => {
      const current = await this.repo.findCurrentRecord(input.employeeId, input.courseId, tx);

      if (current) {
        if (current.completedOn > input.completedOn) {
          // Backdating behind the live record would make the OLDER completion current, so the
          // answer to "is this person trained?" would go backwards.
          throw new PreconditionFailedException(
            ErrorCodes.TRAINING_INVALID_COMPLETION,
            `A newer completion already exists for ${course.code} (${current.completedOn})`,
          );
        }
        // Guarded on the link still being null, so two concurrent retrainings cannot both claim to
        // have replaced this record.
        await this.repo.linkSuccessor(current.id, successorId, tx);
      }

      const created = await this.repo.createRecord({ ...input, expiresOn, id: successorId }, tx);

      await this.audit.recordChange(
        actor,
        AUDIT_ACTION.TRAINING_RECORDED,
        AUDIT_RESOURCE.TRAINING_RECORD,
        created.id,
        {
          before: current ? { supersededRecordId: current.id } : null,
          after: {
            employeeId: created.employeeId,
            courseCode: course.code,
            completedOn: created.completedOn,
            expiresOn: created.expiresOn,
          },
        },
        tx,
      );
      return created;
    });
  }

  async getRecord(id: string): Promise<TrainingRecord> {
    const record = await this.repo.findRecordById(id);
    if (!record) throw new NotFoundException(ErrorCodes.NOT_FOUND, `Record ${id} not found`);
    return record;
  }

  /**
   * One record, with the employee it belongs to named — the drawer's read path.
   *
   * Separate from `getRecord` rather than folded into it, because that one is the guard nearly every
   * other path here calls first: verify, revoke, and all five certificate routes go through it, and
   * `assertMayAttach` in the controller calls it on every upload. None of those render a person's
   * name. Widening `getRecord` would have bought one screen a name at the cost of a directory lookup
   * on every attachment presign, confirm, download and delete.
   */
  async getRecordWithEmployee(
    id: string,
  ): Promise<TrainingRecord & { employeeName: string | null }> {
    const record = await this.getRecord(id);
    const names = await resolveEmployeeNames(this.db, [record.employeeId]);
    return { ...record, employeeName: nameOf(names, record.employeeId) };
  }

  async listRecords(filters: RecordFilters, limit: number, offset: number) {
    const page = await this.repo.listRecords(filters, limit, offset);
    /*
     * THE EMPLOYEE COLUMN, by name, for the whole page in one query.
     *
     * This list is the org-wide view of who has completed what, so its Employee column is the only
     * thing that says which person a row is about — and it rendered `employeeId`, thirty-six
     * characters that identify nobody. Worse here than most, because uuid v7 time-prefixes make the
     * records filed in one batch look like each other.
     *
     * Resolved on the server rather than in the SPA because `GET /v1/employees` needs
     * `employee.read`, which a `training.read` holder is not required to hold — the auditor tier is
     * exactly that shape, and it would have got a 403 and a column of dashes.
     */
    const names = await resolveEmployeeNames(
      this.db,
      page.rows.map((r) => r.employeeId),
    );
    return {
      ...page,
      rows: page.rows.map((r) => ({ ...r, employeeName: nameOf(names, r.employeeId) })),
    };
  }

  async listRecordsForEmployee(employeeId: string): Promise<TrainingRecord[]> {
    return this.repo.listRecordsForEmployee(employeeId);
  }

  /**
   * Attest that the evidence is genuine.
   *
   * Once only: overwriting who attested and when would erase the one fact an ISO competency audit
   * actually reads. The repository's WHERE clause is what enforces that, not this check.
   */
  async verifyRecord(id: string, actor: Actor): Promise<TrainingRecord> {
    const record = await this.getRecord(id);
    if (record.status === 'revoked') {
      throw new PreconditionFailedException(
        ErrorCodes.TRAINING_RECORD_NOT_VERIFIABLE,
        'A revoked record cannot be verified',
      );
    }

    return this.db.transaction(async (tx) => {
      const verified = await this.repo.markVerified(id, actor.sub, tx);
      if (!verified) {
        throw new ConflictException(
          ErrorCodes.TRAINING_RECORD_NOT_VERIFIABLE,
          'That record has already been verified',
        );
      }
      await this.audit.recordChange(
        actor,
        AUDIT_ACTION.TRAINING_VERIFIED,
        AUDIT_RESOURCE.TRAINING_RECORD,
        id,
        {
          after: { verifiedBy: actor.sub },
        },
        tx,
      );
      return verified;
    });
  }

  /** Revoke a record — evidence that turned out to be wrong. The reason is required. */
  async revokeRecord(id: string, reason: string, actor: Actor): Promise<TrainingRecord> {
    const record = await this.getRecord(id);
    if (record.status === 'revoked') {
      throw new PreconditionFailedException(
        ErrorCodes.TRAINING_RECORD_NOT_VERIFIABLE,
        'That record is already revoked',
      );
    }

    return this.db.transaction(async (tx) => {
      const revoked = await this.repo.transitionRecord(
        id,
        record.status,
        'revoked',
        { revokedReason: reason },
        tx,
      );
      if (!revoked) {
        throw new ConflictException(
          ErrorCodes.TRAINING_RECORD_NOT_VERIFIABLE,
          'That record changed while being revoked',
        );
      }
      await this.audit.recordChange(
        actor,
        AUDIT_ACTION.TRAINING_REVOKED,
        AUDIT_RESOURCE.TRAINING_RECORD,
        id,
        {
          before: { status: record.status },
          after: { status: 'revoked', revokedReason: reason },
        },
        tx,
      );
      return revoked;
    });
  }

  // ── Certificates ─────────────────────────────────────────────────────────────
  //
  // Mechanics live in `EntityAttachmentsService`; what stays here is proving the record exists and
  // naming the surface. That is the split rally settled on, and the reason a new upload surface is a
  // policy descriptor rather than another copy of presign/confirm.

  private ref(recordId: string): AttachmentRef {
    return { entityType: RECORD_ENTITY, entityId: recordId };
  }

  async listCertificates(recordId: string): Promise<EntityAttachment[]> {
    await this.getRecord(recordId);
    return this.attachments.list(this.ref(recordId));
  }

  async presignCertificate(
    recordId: string,
    input: { fileName: string; mimeType: string; sizeBytes: number; checksumSha256?: string },
    actor: Actor,
  ): Promise<{ fileId: string; uploadUrl: string; requiredHeaders: Record<string, string> }> {
    await this.getRecord(recordId);
    return this.attachments.presign(this.ref(recordId), CERTIFICATE_SURFACE, input, actor.sub);
  }

  async confirmCertificate(
    recordId: string,
    fileId: string,
    actor: Actor,
  ): Promise<EntityAttachment> {
    const record = await this.getRecord(recordId);
    const attachment = await this.attachments.confirm(
      this.ref(recordId),
      CERTIFICATE_SURFACE,
      fileId,
      actor.sub,
    );

    await this.db.transaction(async (tx) => {
      await this.audit.recordChange(
        actor,
        AUDIT_ACTION.TRAINING_CERTIFICATE_ATTACHED,
        AUDIT_RESOURCE.TRAINING_RECORD,
        record.id,
        { after: { fileId, fileName: attachment.fileName } },
        tx,
      );
    });
    return attachment;
  }

  async certificateDownloadUrl(recordId: string, fileId: string): Promise<string> {
    await this.getRecord(recordId);
    return this.attachments.downloadUrl(this.ref(recordId), fileId);
  }

  /**
   * Remove a certificate.
   *
   * `force` carries the owning module's own rule: the uploader may always remove their own file,
   * and a `training.manage` holder may remove anyone's. `EntityAttachmentsService` deliberately
   * does not know what a manager is.
   */
  async removeCertificate(
    recordId: string,
    fileId: string,
    actor: Actor,
    canManage: boolean,
  ): Promise<void> {
    const record = await this.getRecord(recordId);
    await this.attachments.remove(this.ref(recordId), fileId, actor.sub, canManage);

    await this.db.transaction(async (tx) => {
      await this.audit.recordChange(
        actor,
        AUDIT_ACTION.TRAINING_CERTIFICATE_REMOVED,
        AUDIT_RESOURCE.TRAINING_RECORD,
        record.id,
        { before: { fileId } },
        tx,
      );
    });
  }

  // ── The report ───────────────────────────────────────────────────────────────

  /**
   * Who is missing training their CURRENT position requires.
   *
   * The whole reason requirements hang off the position: this answers "is the org competent?"
   * rather than "what has Mai done?", and it stays correct through a transfer without a backfill.
   */
  async competencyGaps(input: {
    employeeId?: string;
    positionId?: string;
    asOf?: string;
    includeRecommended?: boolean;
  }): Promise<(CompetencyGap & { employeeName: string | null })[]> {
    const rows = await this.repo.competencyGaps({
      employeeId: input.employeeId,
      positionId: input.positionId,
      asOf: input.asOf ?? today(),
      includeRecommended: input.includeRecommended ?? false,
    });
    /*
     * WHO IS MISSING THE TRAINING, by name.
     *
     * Unlike the performance module's coverage-gap report, which drives off `employees` and so gets
     * `displayName` from the same row it already selects, this query drives off `employee_positions`
     * and never touches the directory. Adding an inner join to `employees` here would also change
     * what the report MEANS: a gap would disappear along with the person's row, which is the failure
     * mode `resolveEmployeeNames` is a left lookup to avoid.
     *
     * Filtering by position is the common case — "what is my team missing" — and that returns one
     * row per person per course, so several rows share an employee. The resolver deduplicates, so a
     * position with twelve requirements and four holders is four ids, not forty-eight.
     */
    const names = await resolveEmployeeNames(
      this.db,
      rows.map((r) => r.employeeId),
    );
    return rows.map((r) => ({ ...r, employeeName: nameOf(names, r.employeeId) }));
  }

  // ── Shared internals ─────────────────────────────────────────────────────────
}
