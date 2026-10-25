import type { storedFileStatusEnum } from '../../../../db/schema';
/**
 * Storage types — upload policy descriptors, DTOs, and lifecycle constants.
 *
 * ONE DESCRIPTOR PER UPLOAD SURFACE, and the surface name is the key prefix every object of
 * that kind lives under. `StorageService` enforces the descriptor; the owning module enforces
 * authorization. That split is the point: the mechanics (key layout, presign, checksum,
 * size/MIME/quota gates, confirm, reap) are identical everywhere, while "may this actor attach
 * to this thing?" depends on the owning context's permission model.
 *
 * Adding a surface is a descriptor here plus, for multi-file surfaces, a link row in
 * `storage.attachments`. It is never a change to `StorageService`.
 *
 * Ported from rova's `attachment-policy.ts`, which reached this shape after every new upload
 * surface had produced another copy of presign/confirm.
 *
 *   - allowedMimeTypes    — checked against the client-declared Content-Type
 *   - maxSizeBytes        — client declares size; HeadObject verifies it on confirm
 *   - maxPerOwner         — completed files per owning entity; `null` for the 1:1 surfaces that
 *                           replace rather than accumulate
 *   - inlineDisposition   — may the browser RENDER this, or must it always download?
 *
 * SVG IS EXCLUDED FROM EVERY POLICY, deliberately and permanently. It is an active-content
 * format (inline `<script>`, `foreignObject`, external refs), so an "image" upload becomes
 * stored XSS the moment the bytes are served from an origin the app trusts — which is exactly
 * what `CDN_FILES_BASE_URL` does. A surface that must render inline pays for it by accepting
 * raster only.
 */

const MB = 1024 * 1024;

/** Raster only — no SVG. Safe to render inline. */
const RASTER_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

export const RESOURCE_RULES = {
  /** Employee profile photo — rendered in the shell, so inline, so raster only. */
  'employee-avatar': {
    allowedMimeTypes: RASTER_IMAGE_MIME_TYPES,
    maxSizeBytes: 5 * MB,
    maxPerOwner: null,
    inlineDisposition: true,
  },
  /** Physical asset inspection / inventory photo — shown on the asset page. */
  'asset-photo': {
    allowedMimeTypes: RASTER_IMAGE_MIME_TYPES,
    maxSizeBytes: 10 * MB,
    maxPerOwner: null,
    inlineDisposition: true,
  },
  /** Medical certificate or other leave supporting document */
  'leave-document': {
    allowedMimeTypes: ['application/pdf', 'image/jpeg', 'image/png'],
    maxSizeBytes: 10 * MB,
    maxPerOwner: null,
    inlineDisposition: false,
  },
  /** Access request justification document */
  'access-request-document': {
    allowedMimeTypes: [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ],
    maxSizeBytes: 10 * MB,
    maxPerOwner: null,
    inlineDisposition: false,
  },
  /** Compliance / audit report export (generated or uploaded) */
  'compliance-report': {
    allowedMimeTypes: [
      'application/pdf',
      'text/csv',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ],
    maxSizeBytes: 50 * MB,
    maxPerOwner: null,
    inlineDisposition: false,
  },
  /**
   * Training certificate or transcript evidencing one completed course.
   *
   * The first surface that ACCUMULATES: a course can be evidenced by a certificate plus a
   * transcript plus a score report, so it carries a quota and a link table rather than a single
   * key column on the domain row. `inlineDisposition: false` because a certificate is uploaded
   * by whoever completed the course — the least trusted input in the system.
   */
  'training-certificate': {
    allowedMimeTypes: [
      'application/pdf',
      'image/jpeg',
      'image/png',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ],
    maxSizeBytes: 20 * MB,
    maxPerOwner: 5,
    inlineDisposition: false,
  },
} as const;

export type ResourceType = keyof typeof RESOURCE_RULES;

/** The shape every entry in `RESOURCE_RULES` satisfies — see the file header for each field. */
export interface UploadPolicy {
  readonly allowedMimeTypes: readonly string[];
  readonly maxSizeBytes: number;
  readonly maxPerOwner: number | null;
  readonly inlineDisposition: boolean;
}
export const VALID_RESOURCE_TYPES = Object.keys(RESOURCE_RULES) as ResourceType[];

/** Presigned PUT URL TTL — client must start the upload within this window. */
export const UPLOAD_URL_TTL_SECONDS = 300; // 5 min

/** Presigned GET URL TTL — short enough to limit a leaked URL's exposure window. */
export const DOWNLOAD_URL_TTL_SECONDS = 900; // 15 min

/** Orphaned `pending` files older than this are purged by StorageCleanupCron. */
export const ORPHAN_CUTOFF_HOURS = 24;

// ── Domain types ──────────────────────────────────────────────────────────────

/** Derived from the DB enum so adding a value there cannot leave this list stale. */
export type StoredFileStatus = (typeof storedFileStatusEnum.enumValues)[number];

export interface StoredFile {
  id: string;
  key: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  resourceType: string;
  /** Base64 SHA-256 declared by the client at presign, re-read from storage on confirm. */
  checksumSha256: string | null;
  status: StoredFileStatus;
  uploaderId: string;
  linkedEntityType: string | null;
  linkedEntityId: string | null;
  createdAt: Date;
  confirmedAt: Date | null;
}

// ── Service I/O ───────────────────────────────────────────────────────────────

export interface PresignUploadInput {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  resourceType: ResourceType;
  /**
   * Base64-encoded SHA-256 of the bytes, computed by the client.
   *
   * Recorded at presign and compared on confirm against whatever the backend reports. NOT
   * enforced at PUT time: a presigned PUT cannot carry a checksum requirement without the client
   * also sending the matching `x-amz-checksum-sha256` header, and requiring that would break
   * every existing caller. Size alone cannot catch a same-length substitution, which is why this
   * is worth recording even as an advisory check.
   */
  checksumSha256?: string;
  /** Optional polymorphic link set at presign time so the cleanup cron can correlate orphans. */
  linkedEntityType?: string;
  linkedEntityId?: string;
}

export interface PresignUploadResult {
  fileId: string;
  uploadUrl: string;
  key: string;
  /**
   * Exactly the headers the signature covers — the client must send all of them and nothing extra.
   *
   * Fewer fails the signature and so does more, which is why this is returned rather than
   * documented: a client guessing the set is a client that intermittently gets a 403 with no CORS
   * headers, surfacing in the browser as an opaque "Failed to fetch".
   */
  requiredHeaders: Record<string, string>;
}

export interface ConfirmUploadResult {
  fileId: string;
  key: string;
  /** CDN URL if configured, otherwise presigned S3 GET URL. */
  url: string;
}
