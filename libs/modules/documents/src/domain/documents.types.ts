export type DocumentCategory =
  'isms_policy' | 'qms_procedure' | 'work_instruction' | 'hr_handbook' | 'contract_template';

export type DocumentVersionStatus =
  'draft' | 'in_review' | 'approved' | 'published' | 'superseded' | 'rejected';

export interface ControlledDocument {
  id: string;
  code: string;
  title: string;
  category: DocumentCategory;
  ownerId: string;
  retiredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface DocumentVersion {
  id: string;
  documentId: string;
  version: number;
  body: string | null;
  storageKey: string | null;
  changeSummary: string | null;
  status: DocumentVersionStatus;
  requestId: string | null;
  approvedBy: string | null;
  approvedAt: Date | null;
  publishedAt: Date | null;
  reviewDueOn: string | null;
  supersededAt: Date | null;
  createdAt: Date;
}

export interface CreateDocumentInput {
  code: string;
  title: string;
  category: DocumentCategory;
  ownerId: string;
  /** Content of the first draft. Optional — a document can be registered before it is written. */
  body?: string | null;
}

export interface DocumentFilters {
  category?: DocumentCategory;
  ownerId?: string;
  /** Omit to hide retired documents; `true` includes them. Retirement is soft, never a delete. */
  includeRetired?: boolean;
  /**
   * Free text over `code` and `title`.
   *
   * Here because pickers select a document BY NAME — an audit report, a review's minutes — and a picker
   * that can only offer the first page of a list is one that cannot find document 101. The same reason
   * `roles` grew a search.
   */
  search?: string;
}

/**
 * A published version an employee is expected to have acknowledged but has not.
 *
 * The whole point of keying acknowledgements on the VERSION: this query is what answers "who has
 * not accepted the current policy?", and it only works because acknowledging v1 leaves v2
 * outstanding.
 */
export interface OutstandingAcknowledgement {
  documentId: string;
  code: string;
  title: string;
  category: DocumentCategory;
  versionId: string;
  version: number;
  publishedAt: Date;
}
