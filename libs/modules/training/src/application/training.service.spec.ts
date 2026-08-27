/**
 * TrainingService — derived expiry, the retraining chain, and the refusals around them.
 *
 * WHY UNIT TESTS WHEN THERE IS AN E2E SUITE. `training.e2e.spec.ts` drives the real API, the real
 * `uq_training_record_current` and a real S3 round-trip, which is the only place those can be
 * proven. What it cannot do cheaply is pin ORDER and ARITHMETIC: that the predecessor is superseded
 * BEFORE the successor is inserted, that the successor's id is minted first because the index leaves
 * no other order available, and that a 31st-of-the-month completion lapses on a date that exists.
 *
 * The repository is a stub and the transaction a passthrough, so what is under test is this
 * service's decisions, not Drizzle.
 */
import { describe, expect, it, vi } from 'vitest';
import { ConflictException, PreconditionFailedException, type DrizzleDB } from '@platform';
import { addMonths, today } from '@shared-kernel';
import { TrainingService } from './training.service';
import type { TrainingCourse, TrainingRecord } from '../domain/training.types';
import { createFakeAudit } from '../../../audit/src/testing/audit.fake';

const ACTOR = { sub: 'actor-1', email: 'actor@opshub.local' };

function course(over: Partial<TrainingCourse> = {}): TrainingCourse {
  return {
    id: 'course-1',
    code: 'ISMS-AWARE-01',
    title: 'Security Awareness',
    category: 'information_security',
    provider: null,
    description: null,
    validityMonths: 12,
    retiredAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

function record(over: Partial<TrainingRecord> = {}): TrainingRecord {
  return {
    id: 'rec-1',
    employeeId: 'emp-1',
    courseId: 'course-1',
    completedOn: '2026-01-15',
    expiresOn: '2027-01-15',
    result: null,
    score: null,
    status: 'valid',
    verifiedBy: null,
    verifiedAt: null,
    supersededById: null,
    revokedReason: null,
    notes: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

function makeService(repoOver: Record<string, unknown> = {}) {
  const repo = {
    createCourse: vi.fn().mockResolvedValue(course()),
    findCourseById: vi.fn().mockResolvedValue(course()),
    findCourseByCode: vi.fn().mockResolvedValue(null),
    listCourses: vi.fn().mockResolvedValue({ rows: [], total: 0 }),
    updateCourse: vi
      .fn()
      .mockImplementation((id: string, input: Partial<TrainingCourse>) =>
        Promise.resolve(course({ id, ...input })),
      ),
    retireCourse: vi.fn().mockResolvedValue(course({ retiredAt: new Date() })),
    addRequirement: vi.fn().mockResolvedValue({
      id: 'req-1',
      positionId: 'pos-1',
      courseId: 'course-1',
      kind: 'mandatory',
      graceDays: null,
      createdAt: new Date(),
    }),
    findRequirement: vi.fn().mockResolvedValue(null),
    removeRequirement: vi.fn().mockResolvedValue({
      id: 'req-1',
      positionId: 'pos-1',
      courseId: 'course-1',
      kind: 'mandatory',
      graceDays: null,
      createdAt: new Date(),
    }),
    listRequirementsForPosition: vi.fn().mockResolvedValue([]),
    createRecord: vi
      .fn()
      .mockImplementation((input: Record<string, unknown>) =>
        Promise.resolve(record({ id: (input.id as string) ?? 'rec-new', ...input })),
      ),
    findRecordById: vi.fn().mockResolvedValue(record()),
    findCurrentRecord: vi.fn().mockResolvedValue(null),
    listRecords: vi.fn().mockResolvedValue({ rows: [], total: 0 }),
    listRecordsForEmployee: vi.fn().mockResolvedValue([]),
    transitionRecord: vi
      .fn()
      .mockImplementation((id: string, _f: string, to: TrainingRecord['status']) =>
        Promise.resolve(record({ id, status: to })),
      ),
    linkSuccessor: vi.fn().mockResolvedValue(undefined),
    markVerified: vi
      .fn()
      .mockImplementation((id: string, verifiedBy: string) =>
        Promise.resolve(record({ id, verifiedBy, verifiedAt: new Date() })),
      ),
    competencyGaps: vi.fn().mockResolvedValue([]),
    ...repoOver,
  };
  const TX = { tx: true };
  const transaction = vi.fn((fn: (tx: unknown) => Promise<unknown>) => fn(TX));
  const db = { transaction } as unknown as DrizzleDB;
  const audit = createFakeAudit();
  const attachments = {
    list: vi.fn().mockResolvedValue([]),
    presign: vi.fn().mockResolvedValue({ fileId: 'f1', uploadUrl: 'u', requiredHeaders: {} }),
    confirm: vi.fn().mockResolvedValue({
      fileId: 'f1',
      fileName: 'cert.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 10,
      checksumSha256: null,
      uploadedBy: 'emp-1',
      attachedBy: 'emp-1',
      attachedAt: new Date(),
    }),
    downloadUrl: vi.fn().mockResolvedValue('https://example/x'),
    remove: vi.fn().mockResolvedValue(undefined),
  };

  const service = new TrainingService(repo, db, audit as never, attachments as never);
  return { service, repo, db, transaction, audit, attachments, TX };
}

describe('addMonths', () => {
  it('clamps to the last day of the target month', () => {
    // The case a bare `setUTCMonth` gets wrong: January 31st plus one month has no 31st to land on
    // and rolls into March, so a certificate would appear to last three days longer than it does.
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29');
    expect(addMonths('2026-03-31', 1)).toBe('2026-04-30');
  });

  it('handles ordinary months, year boundaries and multi-year validity', () => {
    expect(addMonths('2026-01-15', 12)).toBe('2027-01-15');
    expect(addMonths('2026-12-01', 1)).toBe('2027-01-01');
    expect(addMonths('2026-06-30', 24)).toBe('2028-06-30');
  });

  it('formats today in UTC', () => {
    expect(today(new Date('2026-03-01T23:30:00Z'))).toBe('2026-03-01');
  });
});

describe('createCourse', () => {
  it('refuses a duplicate code before writing anything', async () => {
    const { service, repo } = makeService({
      findCourseByCode: vi.fn().mockResolvedValue(course()),
    });

    await expect(
      service.createCourse({ code: 'ISMS-AWARE-01', title: 'X', category: 'safety' }, ACTOR),
    ).rejects.toThrow(ConflictException);
    expect(repo.createCourse).not.toHaveBeenCalled();
  });

  it('writes the audit entry inside the transaction', async () => {
    const { service, audit, TX } = makeService();

    await service.createCourse({ code: 'NEW-01', title: 'X', category: 'safety' }, ACTOR);

    expect(audit.record).toHaveBeenCalledWith(expect.anything(), TX);
  });
});

describe('addRequirement', () => {
  it('refuses to require a retired course', async () => {
    const { service, repo } = makeService({
      findCourseById: vi.fn().mockResolvedValue(course({ retiredAt: new Date() })),
    });

    await expect(
      service.addRequirement({ positionId: 'pos-1', courseId: 'course-1' }, ACTOR),
    ).rejects.toThrow(PreconditionFailedException);
    expect(repo.addRequirement).not.toHaveBeenCalled();
  });

  it('refuses a duplicate requirement', async () => {
    const { service, repo } = makeService({
      findRequirement: vi.fn().mockResolvedValue({ id: 'req-1' }),
    });

    await expect(
      service.addRequirement({ positionId: 'pos-1', courseId: 'course-1' }, ACTOR),
    ).rejects.toThrow(ConflictException);
    expect(repo.addRequirement).not.toHaveBeenCalled();
  });

  it('defaults the kind to mandatory', async () => {
    const { service, repo } = makeService();

    await service.addRequirement({ positionId: 'pos-1', courseId: 'course-1' }, ACTOR);

    expect(repo.addRequirement).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'mandatory' }),
      expect.anything(),
    );
  });
});

describe('recordCompletion', () => {
  const input = { employeeId: 'emp-1', courseId: 'course-1', completedOn: '2026-01-31' };

  it('derives the expiry from the course and freezes it', async () => {
    const { service, repo } = makeService({
      findCourseById: vi.fn().mockResolvedValue(course({ validityMonths: 12 })),
    });

    await service.recordCompletion(input, ACTOR);

    expect(repo.createRecord).toHaveBeenCalledWith(
      expect.objectContaining({ completedOn: '2026-01-31', expiresOn: '2027-01-31' }),
      expect.anything(),
    );
  });

  it('leaves the expiry null for a course that never lapses', async () => {
    const { service, repo } = makeService({
      findCourseById: vi.fn().mockResolvedValue(course({ validityMonths: null })),
    });

    await service.recordCompletion(input, ACTOR);

    expect(repo.createRecord).toHaveBeenCalledWith(
      expect.objectContaining({ expiresOn: null }),
      expect.anything(),
    );
  });

  it('refuses a completion dated in the future', async () => {
    const { service, repo } = makeService();

    await expect(
      service.recordCompletion({ ...input, completedOn: '2999-01-01' }, ACTOR),
    ).rejects.toMatchObject({ code: 'TRAINING_INVALID_COMPLETION' });
    expect(repo.createRecord).not.toHaveBeenCalled();
  });

  it('refuses a completion against a retired course', async () => {
    const { service, repo } = makeService({
      findCourseById: vi.fn().mockResolvedValue(course({ retiredAt: new Date() })),
    });

    await expect(service.recordCompletion(input, ACTOR)).rejects.toThrow(
      PreconditionFailedException,
    );
    expect(repo.createRecord).not.toHaveBeenCalled();
  });

  it('supersedes the live record BEFORE inserting the successor', async () => {
    const order: string[] = [];
    const { service } = makeService({
      findCurrentRecord: vi
        .fn()
        .mockResolvedValue(record({ id: 'rec-old', completedOn: '2025-01-01' })),
      linkSuccessor: vi.fn().mockImplementation(() => {
        order.push('supersede');
        return Promise.resolve();
      }),
      createRecord: vi.fn().mockImplementation((v: Record<string, unknown>) => {
        order.push('insert');
        return Promise.resolve(record({ id: v.id as string }));
      }),
    });

    await service.recordCompletion(input, ACTOR);

    // Forced by `uq_training_record_current`: the predecessor has to stop matching the partial
    // index BEFORE the insert, and the only way it can is by pointing at the successor.
    expect(order).toEqual(['supersede', 'insert']);
  });

  it('points the predecessor at the id the successor is then created with', async () => {
    // The consequence of that ordering: the id is minted in the service, so the two calls must
    // agree. If they ever drift, the chain points at a row that does not exist and nothing fails
    // loudly — `superseded_by_id` carries no FK precisely because it is briefly dangling.
    const { service, repo } = makeService({
      findCurrentRecord: vi
        .fn()
        .mockResolvedValue(record({ id: 'rec-old', completedOn: '2025-01-01' })),
    });

    await service.recordCompletion(input, ACTOR);

    const linkedTo = repo.linkSuccessor.mock.calls[0][1] as string;
    const created = repo.createRecord.mock.calls[0][0] as { id: string };
    expect(created.id).toBe(linkedTo);
  });

  it('reads the live record with the transaction, not the pool', async () => {
    const { service, repo, TX } = makeService();

    await service.recordCompletion(input, ACTOR);

    // Read on the pool, two concurrent completions both believe the slot is free and the index
    // answers with a 500 instead of a domain error.
    expect(repo.findCurrentRecord).toHaveBeenCalledWith('emp-1', 'course-1', TX);
  });

  it('refuses a completion dated behind the live record', async () => {
    const { service, repo } = makeService({
      findCurrentRecord: vi.fn().mockResolvedValue(record({ completedOn: '2026-06-01' })),
    });

    await expect(
      service.recordCompletion({ ...input, completedOn: '2026-01-31' }, ACTOR),
    ).rejects.toMatchObject({ code: 'TRAINING_INVALID_COMPLETION' });
    // Otherwise the OLDER completion becomes current and "is this person trained?" goes backwards.
    expect(repo.linkSuccessor).not.toHaveBeenCalled();
    expect(repo.createRecord).not.toHaveBeenCalled();
  });

  it('does not supersede anything when there is no live record', async () => {
    const { service, repo } = makeService();

    await service.recordCompletion(input, ACTOR);

    expect(repo.linkSuccessor).not.toHaveBeenCalled();
    expect(repo.createRecord).toHaveBeenCalled();
  });
});

describe('verifyRecord', () => {
  it('refuses to verify a revoked record', async () => {
    const { service, repo } = makeService({
      findRecordById: vi.fn().mockResolvedValue(record({ status: 'revoked', revokedReason: 'x' })),
    });

    await expect(service.verifyRecord('rec-1', ACTOR)).rejects.toMatchObject({
      code: 'TRAINING_RECORD_NOT_VERIFIABLE',
    });
    expect(repo.markVerified).not.toHaveBeenCalled();
  });

  it('reports an already-verified record as a conflict', async () => {
    // The repository's WHERE clause is unverified-only, so a null means somebody else attested
    // first. Overwriting would erase who did and when, which is the fact an audit reads.
    const { service } = makeService({ markVerified: vi.fn().mockResolvedValue(null) });

    await expect(service.verifyRecord('rec-1', ACTOR)).rejects.toThrow(ConflictException);
  });

  it('attests as the calling actor', async () => {
    const { service, repo } = makeService();

    await service.verifyRecord('rec-1', ACTOR);

    expect(repo.markVerified).toHaveBeenCalledWith('rec-1', ACTOR.sub, expect.anything());
  });
});

describe('revokeRecord', () => {
  it('refuses to revoke twice', async () => {
    const { service, repo } = makeService({
      findRecordById: vi.fn().mockResolvedValue(record({ status: 'revoked', revokedReason: 'x' })),
    });

    await expect(service.revokeRecord('rec-1', 'again', ACTOR)).rejects.toMatchObject({
      code: 'TRAINING_RECORD_NOT_VERIFIABLE',
    });
    expect(repo.transitionRecord).not.toHaveBeenCalled();
  });

  it('carries the reason onto the row', async () => {
    const { service, repo } = makeService();

    await service.revokeRecord('rec-1', 'certificate forged', ACTOR);

    expect(repo.transitionRecord).toHaveBeenCalledWith(
      'rec-1',
      'valid',
      'revoked',
      { revokedReason: 'certificate forged' },
      expect.anything(),
    );
  });
});

describe('certificates', () => {
  it('proves the record exists before touching storage', async () => {
    const { service, attachments } = makeService({
      findRecordById: vi.fn().mockResolvedValue(null),
    });

    await expect(
      service.presignCertificate(
        'rec-1',
        { fileName: 'c.pdf', mimeType: 'application/pdf', sizeBytes: 10 },
        ACTOR,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // Mechanics stay in `EntityAttachmentsService`; what this service owns is proving the subject
    // exists, so a bad id must never reach a presign.
    expect(attachments.presign).not.toHaveBeenCalled();
  });

  it('refuses to presign against a revoked record', async () => {
    /*
     * THE RULE THAT USED TO LIVE ONLY IN THE BROWSER. `CertificatesPanel` hides Attach when its
     * `frozen` prop is set, and nothing below the component enforced it — `presignCertificate` called
     * `getRecord` and read no status, so a `curl` against the presign route answered 201 on a record
     * somebody had revoked with a reason. Refused at presign rather than only at confirm because this
     * is the cheapest place to say no: no signed PUT is handed out, so no S3 request is spent.
     */
    const { service, attachments } = makeService({
      findRecordById: vi.fn().mockResolvedValue(record({ status: 'revoked', revokedReason: 'x' })),
    });

    await expect(
      service.presignCertificate(
        'rec-1',
        { fileName: 'c.pdf', mimeType: 'application/pdf', sizeBytes: 10 },
        ACTOR,
      ),
      // The same code and the same exception class `verifyRecord` and `revokeRecord` refuse with. A
      // fourth training code would have made one lifecycle rule read as two to every client.
    ).rejects.toMatchObject({ code: 'TRAINING_RECORD_NOT_VERIFIABLE' });
    await expect(
      service.presignCertificate(
        'rec-1',
        { fileName: 'c.pdf', mimeType: 'application/pdf', sizeBytes: 10 },
        ACTOR,
      ),
    ).rejects.toThrow(PreconditionFailedException);
    expect(attachments.presign).not.toHaveBeenCalled();
  });

  it('refuses to confirm against a record revoked while the upload was in flight', async () => {
    /*
     * THE HALF THAT CLOSES THE RULE. A presigned PUT is good for five minutes, so a caller who
     * presigned one second before the revocation still holds a usable URL — and confirm is the point
     * the file becomes VISIBLE. Guarding presign alone would leave that window open, and the result is
     * not reachable by any sweep: an unconfirmed upload is purged by the orphan reaper, a confirmed
     * certificate on a revoked record has to be found by hand.
     */
    const { service, attachments, audit } = makeService({
      findRecordById: vi.fn().mockResolvedValue(record({ status: 'revoked', revokedReason: 'x' })),
    });

    await expect(service.confirmCertificate('rec-1', 'file-1', ACTOR)).rejects.toMatchObject({
      code: 'TRAINING_RECORD_NOT_VERIFIABLE',
    });
    expect(attachments.confirm).not.toHaveBeenCalled();
    // And nothing was written: an audit entry saying a certificate was attached to a revoked record
    // would be a false statement in the one log an ISO competency audit reads.
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('keeps a revoked record’s existing evidence readable', async () => {
    /*
     * THE LIMIT OF THE RULE, and the reason it is `assertAcceptsEvidence` rather than a blanket
     * "revoked records are closed". An audit asks what was on file AT THE TIME, so a revocation that
     * also hid its own evidence would answer that with nothing — and the panel says as much in words
     * ("What is already attached is kept"). A guard added to these two paths would satisfy every
     * assertion above and destroy the history.
     */
    const { service, attachments } = makeService({
      findRecordById: vi.fn().mockResolvedValue(record({ status: 'revoked', revokedReason: 'x' })),
    });

    await service.listCertificates('rec-1');
    await service.certificateDownloadUrl('rec-1', 'file-1');

    expect(attachments.list).toHaveBeenCalled();
    expect(attachments.downloadUrl).toHaveBeenCalled();
  });

  it('names the certificate surface, so the policy governs the upload', async () => {
    const { service, attachments } = makeService();

    await service.presignCertificate(
      'rec-1',
      { fileName: 'c.pdf', mimeType: 'application/pdf', sizeBytes: 10 },
      ACTOR,
    );

    expect(attachments.presign).toHaveBeenCalledWith(
      { entityType: 'training_record', entityId: 'rec-1' },
      'training-certificate',
      expect.anything(),
      ACTOR.sub,
    );
  });

  it('passes the manage decision through as the delete override', async () => {
    const { service, attachments } = makeService();

    await service.removeCertificate('rec-1', 'file-1', ACTOR, true);

    // `EntityAttachmentsService` deliberately does not know what a manager is; the owning module
    // supplies that as a boolean.
    expect(attachments.remove).toHaveBeenCalledWith(
      { entityType: 'training_record', entityId: 'rec-1' },
      'file-1',
      ACTOR.sub,
      true,
    );
  });
});

describe('competencyGaps', () => {
  it('defaults to today and to mandatory only', async () => {
    const { service, repo } = makeService();

    await service.competencyGaps({ employeeId: 'emp-1' });

    expect(repo.competencyGaps).toHaveBeenCalledWith({
      employeeId: 'emp-1',
      positionId: undefined,
      asOf: today(),
      includeRecommended: false,
    });
  });

  it('passes an explicit asOf through, so "who lapses by quarter end" is one request', async () => {
    const { service, repo } = makeService();

    await service.competencyGaps({ asOf: '2027-03-31', includeRecommended: true });

    expect(repo.competencyGaps).toHaveBeenCalledWith(
      expect.objectContaining({ asOf: '2027-03-31', includeRecommended: true }),
    );
  });
});
