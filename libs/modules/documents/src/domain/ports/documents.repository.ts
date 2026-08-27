import type { DbExecutor } from '@platform';
import type {
  ControlledDocument,
  CreateDocumentInput,
  DocumentFilters,
  DocumentVersion,
  DocumentVersionStatus,
  OutstandingAcknowledgement,
} from '../documents.types';

export const DOCUMENTS_REPOSITORY = Symbol('DOCUMENTS_REPOSITORY');

export interface IDocumentsRepository {
  // ── Documents ──────────────────────────────────────────────────────────────
  create(input: CreateDocumentInput, tx?: DbExecutor): Promise<ControlledDocument>;
  findById(id: string): Promise<ControlledDocument | null>;
  /**
   * Which of `ids` name a real controlled document.
   *
   * ONE QUERY FOR ALL OF THEM, mirroring `IEmployeeRepository.findExistingIds`: four modules point at
   * documents across a schema boundary and none of them may carry a foreign key, so the alternative to
   * this is a lookup per reference and a refusal that names only the first one wrong.
   *
   * RETIRED DOCUMENTS COUNT AS EXISTING. Retirement is soft — the agreement or report that was in
   * force when the evidence was filed is still the evidence, and refusing a reference to it would make
   * retiring a document silently invalidate every record citing it.
   */
  findExistingIds(ids: string[]): Promise<string[]>;
  findByCode(code: string): Promise<ControlledDocument | null>;
  list(
    filters: DocumentFilters,
    limit: number,
    offset: number,
  ): Promise<{ rows: ControlledDocument[]; total: number }>;
  retire(id: string, tx?: DbExecutor): Promise<boolean>;

  // ── Versions ───────────────────────────────────────────────────────────────
  createVersion(
    input: {
      documentId: string;
      version: number;
      body?: string | null;
      changeSummary?: string | null;
    },
    tx?: DbExecutor,
  ): Promise<DocumentVersion>;
  findVersionById(id: string): Promise<DocumentVersion | null>;
  listVersions(documentId: string): Promise<DocumentVersion[]>;
  /** Highest version number for a document, or 0 when it has none. */
  maxVersion(documentId: string, tx?: DbExecutor): Promise<number>;
  /** The version currently in force, if any. */
  findPublishedVersion(documentId: string, tx?: DbExecutor): Promise<DocumentVersion | null>;
  updateVersionContent(
    id: string,
    input: { body?: string | null; changeSummary?: string | null },
    tx?: DbExecutor,
  ): Promise<DocumentVersion | null>;
  setVersionStatus(
    id: string,
    status: DocumentVersionStatus,
    extra?: {
      requestId?: string | null;
      approvedBy?: string | null;
      approvedAt?: Date | null;
      publishedAt?: Date | null;
      supersededAt?: Date | null;
      reviewDueOn?: string | null;
    },
    tx?: DbExecutor,
  ): Promise<DocumentVersion | null>;

  // ── Acknowledgements ───────────────────────────────────────────────────────
  /**
   * Record an acknowledgement. Idempotent: the unique index on (version_id, employee_id) means a
   * second click is the same acknowledgement, not a second row to reconcile.
   *
   * Returns true when a row was actually inserted, so the caller can tell a fresh acknowledgement
   * from a repeat and avoid writing a duplicate audit entry.
   */
  acknowledge(versionId: string, employeeId: string, tx?: DbExecutor): Promise<boolean>;
  hasAcknowledged(versionId: string, employeeId: string): Promise<boolean>;
  /** Published versions this employee has not acknowledged. */
  listOutstandingFor(employeeId: string): Promise<OutstandingAcknowledgement[]>;
  /** Employee ids that HAVE acknowledged a version — the compliance view for one document. */
  listAcknowledgedBy(versionId: string): Promise<{ employeeId: string; acknowledgedAt: Date }[]>;
}
