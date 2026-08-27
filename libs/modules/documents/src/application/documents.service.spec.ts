/**
 * DocumentsService — the refusal branches and the publish ordering.
 *
 * WHY UNIT TESTS WHEN THERE IS AN E2E SUITE. `controlled-documents.e2e.spec.ts` walks the happy
 * lifecycle through the real API and database, which is the only way to prove the engine's
 * separation of duties and the partial unique index. What it cannot do cheaply is drive every
 * refusal: publishing something not approved, editing a version that has moved on, acknowledging a
 * superseded revision. Each needs a specific state that takes several API calls to reach and one
 * line to fake here.
 *
 * The repository is a stub and the transaction a passthrough, so what is under test is this
 * service's decisions — the order it supersedes in, which errors it maps, and when it writes an
 * audit entry — not Drizzle.
 */
import { describe, expect, it, vi } from 'vitest';
import { ConflictException, PreconditionFailedException, type DrizzleDB } from '@platform';
import { DocumentsService } from './documents.service';
import type { ControlledDocument, DocumentVersion } from '../domain/documents.types';
import { createFakeAudit } from '../../../audit/src/testing/audit.fake';

const ACTOR = { sub: 'actor-1', email: 'actor@opshub.local' };

const DOC: ControlledDocument = {
  id: 'doc-1',
  code: 'POL-001',
  title: 'Policy',
  category: 'isms_policy',
  ownerId: 'owner-1',
  retiredAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function version(over: Partial<DocumentVersion> = {}): DocumentVersion {
  return {
    id: 'ver-1',
    documentId: 'doc-1',
    version: 1,
    body: 'text',
    storageKey: null,
    changeSummary: null,
    status: 'draft',
    requestId: null,
    approvedBy: null,
    approvedAt: null,
    publishedAt: null,
    reviewDueOn: null,
    supersededAt: null,
    createdAt: new Date(),
    ...over,
  };
}

function makeService(repoOver: Record<string, unknown> = {}) {
  const repo = {
    create: vi.fn().mockResolvedValue(DOC),
    findById: vi.fn().mockResolvedValue(DOC),
    // Echoes back every id it is asked about, so a case that does not care about references is not
    // silently exercising the not-found path.
    findExistingIds: vi.fn().mockImplementation((ids: string[]) => Promise.resolve(ids)),
    findByCode: vi.fn().mockResolvedValue(null),
    list: vi.fn().mockResolvedValue({ rows: [DOC], total: 1 }),
    retire: vi.fn().mockResolvedValue(true),
    createVersion: vi.fn().mockResolvedValue(version()),
    findVersionById: vi.fn().mockResolvedValue(version()),
    listVersions: vi.fn().mockResolvedValue([version()]),
    maxVersion: vi.fn().mockResolvedValue(1),
    findPublishedVersion: vi.fn().mockResolvedValue(null),
    updateVersionContent: vi.fn().mockResolvedValue(version()),
    setVersionStatus: vi
      .fn()
      .mockImplementation(
        (id: string, status: DocumentVersion['status'], extra: Partial<DocumentVersion> = {}) =>
          Promise.resolve(version({ id, status, ...extra })),
      ),
    acknowledge: vi.fn().mockResolvedValue(true),
    hasAcknowledged: vi.fn().mockResolvedValue(false),
    listOutstandingFor: vi.fn().mockResolvedValue([]),
    listAcknowledgedBy: vi.fn().mockResolvedValue([]),
    ...repoOver,
  };
  // Passthrough transaction: this service's job is deciding WHAT happens inside one, and the
  // atomicity itself is Postgres's and is covered by the e2e suite.
  //
  // Typed at the declaration via `unknown` rather than asserted at the call site: tsc rejects the
  // bare stub against `NodePgDatabase`, while eslint calls a single `as never` there unnecessary —
  // the two disagree, and widening once here satisfies both.
  const db = {
    transaction: vi.fn((fn: (tx: unknown) => Promise<unknown>) => fn({})),
  } as unknown as DrizzleDB;
  const engine = { submit: vi.fn().mockResolvedValue({ id: 'req-1' }) };
  const audit = createFakeAudit();

  const service = new DocumentsService(repo, db, engine as never, audit as never);
  return { service, repo, db, engine, audit };
}

describe('createDocument', () => {
  it('opens the first draft in the same transaction', async () => {
    const { service, repo, audit } = makeService();

    await service.createDocument(
      { code: 'POL-001', title: 'Policy', category: 'isms_policy', ownerId: 'owner-1' },
      ACTOR,
    );

    // A document with no version has nothing to edit, submit or publish, so the two are created
    // together rather than leaving that state reachable.
    expect(repo.createVersion).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: DOC.id, version: 1 }),
      expect.anything(),
    );
    // Audit inside the transaction — the second argument is the tx.
    expect(audit.record).toHaveBeenCalledWith(expect.anything(), expect.anything());
  });

  it('refuses a duplicate code', async () => {
    const { service, repo } = makeService({ findByCode: vi.fn().mockResolvedValue(DOC) });

    await expect(
      service.createDocument(
        { code: 'POL-001', title: 'Other', category: 'qms_procedure', ownerId: 'owner-1' },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(repo.create).not.toHaveBeenCalled();
  });
});

describe('updateDraft', () => {
  it('maps a no-op update to the reason it failed', async () => {
    // The repository's WHERE clause is draft-only, so a null result means "not a draft" — but the
    // caller needs to know WHICH, and a bare 412 on a missing id would send them hunting.
    const { service } = makeService({
      updateVersionContent: vi.fn().mockResolvedValue(null),
      findVersionById: vi.fn().mockResolvedValue(version({ status: 'published' })),
    });

    await expect(service.updateDraft('ver-1', { body: 'edit' })).rejects.toThrow(
      /Only a draft can be edited; this version is 'published'/,
    );
  });

  it('reports a missing version as missing, not as a status problem', async () => {
    const { service } = makeService({
      updateVersionContent: vi.fn().mockResolvedValue(null),
      findVersionById: vi.fn().mockResolvedValue(null),
    });

    await expect(service.updateDraft('nope', { body: 'edit' })).rejects.toThrow(/not found/);
  });
});

describe('submitForApproval', () => {
  it('refuses anything that is not a draft', async () => {
    const { service, engine } = makeService({
      findVersionById: vi.fn().mockResolvedValue(version({ status: 'in_review' })),
    });

    await expect(service.submitForApproval('ver-1', ACTOR)).rejects.toBeInstanceOf(
      PreconditionFailedException,
    );
    expect(engine.submit).not.toHaveBeenCalled();
  });

  it('hands the version to the engine and records the request id', async () => {
    const { service, engine, repo } = makeService();

    await service.submitForApproval('ver-1', ACTOR);

    expect(engine.submit).toHaveBeenCalledWith(
      'document_approval',
      expect.objectContaining({ versionId: 'ver-1', documentId: 'doc-1' }),
      ACTOR,
    );
    expect(repo.setVersionStatus).toHaveBeenCalledWith('ver-1', 'in_review', {
      requestId: 'req-1',
    });
  });
});

describe('publish', () => {
  it('refuses a version that has not been approved', async () => {
    const { service } = makeService({
      findVersionById: vi.fn().mockResolvedValue(version({ status: 'draft' })),
    });

    await expect(service.publish('ver-1', {}, ACTOR)).rejects.toThrow(
      /Only an approved version can be published/,
    );
  });

  it('supersedes the outgoing version BEFORE publishing the incoming one', async () => {
    // Order is load-bearing, not stylistic: `uq_document_published_version` is a partial unique
    // index over (document_id) where published and not superseded, so publishing first would hit
    // it. This asserts the sequence rather than just the end state.
    const outgoing = version({ id: 'ver-old', version: 1, status: 'published' });
    const { service, repo } = makeService({
      findVersionById: vi
        .fn()
        .mockResolvedValue(version({ id: 'ver-new', version: 2, status: 'approved' })),
      findPublishedVersion: vi.fn().mockResolvedValue(outgoing),
    });

    await service.publish('ver-new', { reviewDueOn: '2029-01-01' }, ACTOR);

    const calls = repo.setVersionStatus.mock.calls.map((c: unknown[]) => [c[0], c[1]]);
    expect(calls).toEqual([
      ['ver-old', 'superseded'],
      ['ver-new', 'published'],
    ]);
  });

  it('publishes without superseding when nothing is in force', async () => {
    const { service, repo } = makeService({
      findVersionById: vi.fn().mockResolvedValue(version({ status: 'approved' })),
      findPublishedVersion: vi.fn().mockResolvedValue(null),
    });

    await service.publish('ver-1', {}, ACTOR);

    expect(repo.setVersionStatus.mock.calls.map((c: unknown[]) => c[1])).toEqual(['published']);
  });

  it('does not supersede itself when republishing the same version', async () => {
    // Guard against the pathological case: superseding then publishing the SAME row would leave it
    // with both timestamps set, which reads as in force and withdrawn at once.
    const same = version({ id: 'ver-1', status: 'approved' });
    const { service, repo } = makeService({
      findVersionById: vi.fn().mockResolvedValue(same),
      findPublishedVersion: vi
        .fn()
        .mockResolvedValue(version({ id: 'ver-1', status: 'published' })),
    });

    await service.publish('ver-1', {}, ACTOR);

    expect(repo.setVersionStatus.mock.calls.map((c: unknown[]) => c[1])).toEqual(['published']);
  });
});

describe('acknowledge', () => {
  it('refuses a draft', async () => {
    const { service } = makeService({
      findVersionById: vi.fn().mockResolvedValue(version({ status: 'draft' })),
    });

    await expect(service.acknowledge('ver-1', ACTOR)).rejects.toThrow(/Only the published version/);
  });

  it('refuses a SUPERSEDED version', async () => {
    // Worse than refusing a draft: accepting this would record current compliance against a policy
    // that is no longer in force.
    const { service } = makeService({
      findVersionById: vi
        .fn()
        .mockResolvedValue(version({ status: 'published', supersededAt: new Date() })),
    });

    await expect(service.acknowledge('ver-1', ACTOR)).rejects.toThrow(/Only the published version/);
  });

  it('audits a NEW acknowledgement', async () => {
    const { service, audit } = makeService({
      findVersionById: vi.fn().mockResolvedValue(version({ status: 'published' })),
      acknowledge: vi.fn().mockResolvedValue(true),
    });

    await expect(service.acknowledge('ver-1', ACTOR)).resolves.toEqual({
      alreadyAcknowledged: false,
    });
    expect(audit.record).toHaveBeenCalled();
  });

  it('does NOT audit a repeat acknowledgement', async () => {
    // The unique index makes the write idempotent; auditing it again would make the trail imply two
    // separate readings of the policy.
    const { service, audit } = makeService({
      findVersionById: vi.fn().mockResolvedValue(version({ status: 'published' })),
      acknowledge: vi.fn().mockResolvedValue(false),
    });

    await expect(service.acknowledge('ver-1', ACTOR)).resolves.toEqual({
      alreadyAcknowledged: true,
    });
    expect(audit.record).not.toHaveBeenCalled();
  });
});

describe('createDraft', () => {
  it('numbers the next version from the current maximum', async () => {
    const { service, repo } = makeService({ maxVersion: vi.fn().mockResolvedValue(7) });

    await service.createDraft('doc-1', { body: 'v8' }, ACTOR);

    expect(repo.createVersion).toHaveBeenCalledWith(
      expect.objectContaining({ version: 8 }),
      expect.anything(),
    );
  });
});

describe('retireDocument', () => {
  it('refuses a document that is already retired', async () => {
    const { service } = makeService({ retire: vi.fn().mockResolvedValue(false) });

    await expect(service.retireDocument('doc-1', ACTOR)).rejects.toThrow(/already retired/);
  });
});

describe('DocumentsService.assertExist', () => {
  /*
   * THE PLURAL PATH HAS NO ROUTE, which is why it is tested here and not in an e2e. Every caller has a
   * single document field, so `missing.join(', ')` can only be reached by calling this directly — and a
   * mutation reducing it to `missing[0]` SURVIVED the e2e for exactly that reason. It stays plural
   * because the method is variadic and the next caller may well pass two.
   */
  it('names EVERY missing id, not just the first', async () => {
    const { service, repo } = makeService();
    repo.findExistingIds.mockResolvedValue([]);

    await expect(service.assertExist('doc-a', 'doc-b')).rejects.toThrow(/doc-a.*doc-b/s);
  });

  it('asks about each id once, however many times it is given', async () => {
    // Deduplicated before the query: two references to the same document are one lookup.
    const { service, repo } = makeService();
    repo.findExistingIds.mockResolvedValue(['doc-a']);

    await service.assertExist('doc-a', 'doc-a', null, undefined);
    expect(repo.findExistingIds).toHaveBeenCalledWith(['doc-a']);
  });

  it('does not touch the database when every reference is absent', async () => {
    /*
     * `inArray(col, [])` is not valid SQL, and a patch that mentions no document at all is the common
     * case — it must not cost a query.
     */
    const { service, repo } = makeService();
    await service.assertExist(null, undefined);
    expect(repo.findExistingIds).not.toHaveBeenCalled();
  });

  it('passes when the reference resolves', async () => {
    const { service, repo } = makeService();
    repo.findExistingIds.mockResolvedValue(['doc-a']);
    await expect(service.assertExist('doc-a')).resolves.toBeUndefined();
  });
});
