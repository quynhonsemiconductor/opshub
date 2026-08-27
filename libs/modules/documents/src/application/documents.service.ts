import { Inject, Injectable } from '@nestjs/common';
import {
  ConflictException,
  ErrorCodes,
  InjectDrizzle,
  NotFoundException,
  PreconditionFailedException,
  RequestEngine,
  nameOf,
  resolveEmployeeNames,
  type DrizzleDB,
} from '@platform';
import type { Actor } from '@shared-kernel';
import { AUDIT_ACTION, AUDIT_RESOURCE, AuditService } from '@modules/audit';
import {
  DOCUMENTS_REPOSITORY,
  type IDocumentsRepository,
} from '../domain/ports/documents.repository';
import type {
  ControlledDocument,
  CreateDocumentInput,
  DocumentFilters,
  DocumentVersion,
  OutstandingAcknowledgement,
} from '../domain/documents.types';
import type { DocumentApprovalPayload } from './document-approval.type-def';

/**
 * Controlled-document lifecycle: draft → in review → approved → published → superseded.
 *
 * WHY THE APPROVAL IS NOT MODELLED HERE. Submitting a version for approval hands it to
 * `RequestEngine`, which already owns multi-step chains, separation of duties, delegation, SLA
 * deadlines, expiry and the audit entry. A `status` column walked by hand would be a second
 * workflow engine without any of that — the exact smell the roadmap warns about. This service owns
 * what the ENGINE cannot know: which version, what supersedes what, and who still has to
 * acknowledge.
 */
@Injectable()
export class DocumentsService {
  constructor(
    @Inject(DOCUMENTS_REPOSITORY) private readonly repo: IDocumentsRepository,
    @InjectDrizzle() private readonly db: DrizzleDB,
    private readonly engine: RequestEngine,
    private readonly audit: AuditService,
  ) {}

  // ── Documents ────────────────────────────────────────────────────────────────

  /** Register a document and open its first draft, atomically. */
  async createDocument(input: CreateDocumentInput, actor: Actor): Promise<ControlledDocument> {
    if (await this.repo.findByCode(input.code)) {
      throw new ConflictException(
        ErrorCodes.CONFLICT,
        `Document code '${input.code}' is already in use`,
      );
    }

    return this.db.transaction(async (tx) => {
      const doc = await this.repo.create(input, tx);
      // A document with no version is a dead end: nothing to edit, submit or publish. Created
      // together so that state cannot exist.
      await this.repo.createVersion({ documentId: doc.id, version: 1, body: input.body }, tx);

      await this.audit.record(
        {
          actorId: actor.sub,
          actorEmail: actor.email,
          action: AUDIT_ACTION.DOCUMENT_CREATED,
          resourceType: AUDIT_RESOURCE.DOCUMENT,
          resourceId: doc.id,
          changes: { after: { code: doc.code, title: doc.title, category: doc.category } },
        },
        tx,
      );
      return doc;
    });
  }

  /**
   * Refuse unless every id given names a real controlled document.
   *
   * WHY IT EXISTS. Five columns across four modules point at `documents.documents` across a schema
   * boundary — the supplier DPA, the SoA control's evidence, a contract's signed document, a
   * non-conformance's evidence and an internal audit's report. None may carry a foreign key, and every
   * one of them was documented as "checked by the service" while nothing checked anything. A dangling
   * reference is the worst kind of compliance record: it reads as complete. An SoA citing evidence
   * that does not exist is an ISO 27001 finding; a contract row naming a document nobody can open is a
   * signed contract on paper only.
   *
   * MIRRORS `EmployeeService.assertExist` deliberately, down to the shape of the message. That is the
   * house pattern for a cross-schema reference, and five ad-hoc `documentExists` helpers — one per
   * caller — is what this replaces. Variadic and nullish-skipping so a caller can hand it whichever
   * optional fields a patch happened to touch without filtering first.
   *
   * NAMES EVERY MISSING ID, not the first: which reference is wrong is the entire content of the
   * failure, and a caller correcting one typo only to meet the next is a worse experience than one
   * refusal listing both.
   *
   * RETIRED DOCUMENTS PASS. Retirement is soft, and the document that was in force when the evidence
   * was filed is still the evidence — see `findExistingIds` on the port.
   */
  async assertExist(...ids: (string | null | undefined)[]): Promise<void> {
    const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))];
    if (wanted.length === 0) return;

    const found = new Set(await this.repo.findExistingIds(wanted));
    const missing = wanted.filter((id) => !found.has(id));
    if (missing.length > 0) {
      throw new NotFoundException(
        ErrorCodes.NOT_FOUND,
        `Controlled document not found: ${missing.join(', ')}`,
      );
    }
  }

  async getDocument(id: string): Promise<ControlledDocument> {
    const doc = await this.repo.findById(id);
    if (!doc) throw new NotFoundException(ErrorCodes.NOT_FOUND, `Document ${id} not found`);
    return doc;
  }

  /**
   * One document, with its owner named — the drawer's read path.
   *
   * Separate from `getDocument` rather than folded into it, because that one is the guard every write
   * path calls first (retire, publish, submit) and none of those render an owner. Widening it would
   * have added a lookup to fifteen mutations to serve one screen.
   */
  async getDocumentWithOwner(
    id: string,
  ): Promise<ControlledDocument & { ownerName: string | null }> {
    const doc = await this.getDocument(id);
    const names = await resolveEmployeeNames(this.db, [doc.ownerId]);
    return { ...doc, ownerName: nameOf(names, doc.ownerId) };
  }

  async listDocuments(filters: DocumentFilters, limit: number, offset: number) {
    const page = await this.repo.list(filters, limit, offset);
    /*
     * OWNER NAMES for the whole page, in one query.
     *
     * The Owner column rendered `ownerId` — thirty-six characters that answer "who is accountable
     * for this policy" with nothing at all. Resolved here rather than in the SPA because the
     * directory endpoint needs `employee.read`, which a document reader is not required to hold.
     */
    const names = await resolveEmployeeNames(
      this.db,
      page.rows.map((r) => r.ownerId),
    );
    return {
      ...page,
      rows: page.rows.map((r) => ({ ...r, ownerName: nameOf(names, r.ownerId) })),
    };
  }

  async listVersions(documentId: string): Promise<DocumentVersion[]> {
    await this.getDocument(documentId);
    return this.repo.listVersions(documentId);
  }

  /** Retire a document. Soft, because a superseded control still has to be explainable later. */
  async retireDocument(id: string, actor: Actor): Promise<void> {
    await this.getDocument(id);
    await this.db.transaction(async (tx) => {
      const retired = await this.repo.retire(id, tx);
      if (!retired) {
        throw new PreconditionFailedException(
          ErrorCodes.PRECONDITION_FAILED,
          'Document is already retired',
        );
      }
      await this.audit.record(
        {
          actorId: actor.sub,
          actorEmail: actor.email,
          action: AUDIT_ACTION.DOCUMENT_RETIRED,
          resourceType: AUDIT_RESOURCE.DOCUMENT,
          resourceId: id,
        },
        tx,
      );
    });
  }

  // ── Versions ─────────────────────────────────────────────────────────────────

  /**
   * Open a new draft on top of the current content.
   *
   * The only way to change a published document: a published version is immutable, because ISO
   * 9001 and 27001 both require knowing which revision was in force on a given date, and an
   * in-place edit destroys exactly that.
   */
  async createDraft(
    documentId: string,
    input: { body?: string | null; changeSummary?: string | null },
    actor: Actor,
  ): Promise<DocumentVersion> {
    await this.getDocument(documentId);

    return this.db.transaction(async (tx) => {
      const next = (await this.repo.maxVersion(documentId, tx)) + 1;
      const version = await this.repo.createVersion(
        { documentId, version: next, body: input.body, changeSummary: input.changeSummary },
        tx,
      );
      await this.audit.record(
        {
          actorId: actor.sub,
          actorEmail: actor.email,
          action: AUDIT_ACTION.DOCUMENT_DRAFT_CREATED,
          resourceType: AUDIT_RESOURCE.DOCUMENT_VERSION,
          resourceId: version.id,
          changes: { after: { documentId, version: next } },
        },
        tx,
      );
      return version;
    });
  }

  async updateDraft(
    versionId: string,
    input: { body?: string | null; changeSummary?: string | null },
  ): Promise<DocumentVersion> {
    // The repository's WHERE clause enforces draft-only, so a concurrent submit cannot slip
    // between a check and a write. A null result therefore means "not a draft", not "missing".
    const updated = await this.repo.updateVersionContent(versionId, input);
    if (!updated) {
      const exists = await this.repo.findVersionById(versionId);
      if (!exists) {
        throw new NotFoundException(ErrorCodes.NOT_FOUND, `Version ${versionId} not found`);
      }
      throw new PreconditionFailedException(
        ErrorCodes.PRECONDITION_FAILED,
        `Only a draft can be edited; this version is '${exists.status}'. Open a new draft instead.`,
      );
    }
    return updated;
  }

  /** Hand a draft to the approval engine. */
  async submitForApproval(versionId: string, actor: Actor): Promise<DocumentVersion> {
    const version = await this.mustGetVersion(versionId);
    if (version.status !== 'draft') {
      throw new PreconditionFailedException(
        ErrorCodes.PRECONDITION_FAILED,
        `Only a draft can be submitted; this version is '${version.status}'`,
      );
    }
    const doc = await this.getDocument(version.documentId);

    const payload: DocumentApprovalPayload = {
      documentId: doc.id,
      documentCode: doc.code,
      documentTitle: doc.title,
      versionId: version.id,
      version: version.version,
      changeSummary: version.changeSummary,
    };
    const item = await this.engine.submit('document_approval', payload, actor);

    const updated = await this.repo.setVersionStatus(versionId, 'in_review', {
      requestId: item.id,
    });
    return updated!;
  }

  /**
   * Publish an approved version, superseding whatever it replaces.
   *
   * ORDER MATTERS, AND THE DATABASE ENFORCES IT. `uq_document_published_version` is a partial
   * unique index over (document_id) where the row is published and not superseded, so the outgoing
   * version must be marked superseded BEFORE the incoming one is published — doing it the other
   * way round hits the index. That is the intended behaviour rather than an obstacle: it means two
   * concurrent publishes cannot both succeed, which no amount of service-level checking can
   * guarantee.
   */
  async publish(
    versionId: string,
    input: { reviewDueOn?: string | null },
    actor: Actor,
  ): Promise<DocumentVersion> {
    const version = await this.mustGetVersion(versionId);
    if (version.status !== 'approved') {
      throw new PreconditionFailedException(
        ErrorCodes.PRECONDITION_FAILED,
        `Only an approved version can be published; this version is '${version.status}'`,
      );
    }

    return this.db.transaction(async (tx) => {
      const now = new Date();
      const current = await this.repo.findPublishedVersion(version.documentId, tx);
      if (current && current.id !== versionId) {
        // Supersede FIRST — see the docblock.
        await this.repo.setVersionStatus(current.id, 'superseded', { supersededAt: now }, tx);
      }

      const published = await this.repo.setVersionStatus(
        versionId,
        'published',
        { publishedAt: now, reviewDueOn: input.reviewDueOn ?? null },
        tx,
      );

      await this.audit.record(
        {
          actorId: actor.sub,
          actorEmail: actor.email,
          action: AUDIT_ACTION.DOCUMENT_PUBLISHED,
          resourceType: AUDIT_RESOURCE.DOCUMENT_VERSION,
          resourceId: versionId,
          changes: {
            before: current ? { supersededVersionId: current.id, version: current.version } : null,
            after: { version: published!.version, reviewDueOn: input.reviewDueOn ?? null },
          },
        },
        tx,
      );
      return published!;
    });
  }

  // ── Acknowledgements ─────────────────────────────────────────────────────────

  /**
   * Record that an employee has read the version in force.
   *
   * Only a PUBLISHED version can be acknowledged: consenting to a draft means nothing, and
   * consenting to a superseded one is worse than nothing because it reads as current compliance.
   */
  async acknowledge(versionId: string, actor: Actor): Promise<{ alreadyAcknowledged: boolean }> {
    const version = await this.mustGetVersion(versionId);
    if (version.status !== 'published' || version.supersededAt) {
      throw new PreconditionFailedException(
        ErrorCodes.PRECONDITION_FAILED,
        'Only the published version of a document can be acknowledged',
      );
    }

    return this.db.transaction(async (tx) => {
      const inserted = await this.repo.acknowledge(versionId, actor.sub, tx);
      // Only audit a NEW acknowledgement. A repeat click is the same fact, and writing it twice
      // would make the trail imply two separate readings.
      if (inserted) {
        await this.audit.record(
          {
            actorId: actor.sub,
            actorEmail: actor.email,
            action: AUDIT_ACTION.DOCUMENT_ACKNOWLEDGED,
            resourceType: AUDIT_RESOURCE.DOCUMENT_VERSION,
            resourceId: versionId,
          },
          tx,
        );
      }
      return { alreadyAcknowledged: !inserted };
    });
  }

  /** Published versions this employee still owes an acknowledgement for. */
  async listOutstanding(employeeId: string): Promise<OutstandingAcknowledgement[]> {
    return this.repo.listOutstandingFor(employeeId);
  }

  /** Who has acknowledged a version — the compliance view for one document. */
  async listAcknowledgedBy(versionId: string) {
    await this.mustGetVersion(versionId);
    const rows = await this.repo.listAcknowledgedBy(versionId);
    /*
     * This list is read to answer "who has signed off on this revision", so a uuid per line makes it
     * useless for the only question it is asked. Names resolved in one query for the whole list.
     */
    const names = await resolveEmployeeNames(
      this.db,
      rows.map((r) => r.employeeId),
    );
    return rows.map((r) => ({ ...r, employeeName: nameOf(names, r.employeeId) }));
  }

  private async mustGetVersion(id: string): Promise<DocumentVersion> {
    const version = await this.repo.findVersionById(id);
    if (!version) {
      throw new NotFoundException(ErrorCodes.NOT_FOUND, `Document version ${id} not found`);
    }
    return version;
  }
}
