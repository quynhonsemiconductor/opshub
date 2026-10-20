/**
 * storage schema — lifecycle-tracked file records for presigned S3 uploads.
 *
 * Every upload goes through three states:
 *   pending   — presign issued, client has not yet PUT to S3
 *   completed — confirmUpload verified the object exists in S3
 *   deleted   — soft-deleted (S3 object purged asynchronously)
 *
 * The StorageCleanupCron purges rows that remain `pending` for > 24 h (orphaned
 * uploads where the client started but never finished).
 */
import {
  pgSchema,
  uuid,
  varchar,
  integer,
  timestamp,
  index,
  primaryKey,
} from 'drizzle-orm/pg-core';
import { storedFileStatusEnum } from './enums';

export const storageSchema = pgSchema('storage');

export const storedFiles = storageSchema.table(
  'stored_files',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** S3 object key — globally unique path within the bucket. */
    key: varchar('key', { length: 512 }).notNull(),
    originalName: varchar('original_name', { length: 255 }).notNull(),
    mimeType: varchar('mime_type', { length: 127 }).notNull(),
    /** Declared size at presign time; verified against HeadObject on confirm. */
    sizeBytes: integer('size_bytes').notNull(),
    /** Domain-scoped bucket prefix, e.g. 'employee-avatar', 'asset-photo'. */
    resourceType: varchar('resource_type', { length: 64 }).notNull(),
    /**
     * Base64 SHA-256 declared by the client at presign, re-read from the backend on confirm.
     *
     * 44 characters for a base64 SHA-256. Nullable because nothing enforces a checksum at PUT
     * time and the surfaces that predate this column never declared one; where both sides have a
     * value, comparing them is the only check that catches a same-length substitution.
     */
    checksumSha256: varchar('checksum_sha256', { length: 64 }),
    status: storedFileStatusEnum('status').notNull().default('pending'),
    /** Employee id who initiated the upload. */
    uploaderId: uuid('uploader_id').notNull(),
    /** Polymorphic link so a cleanup query can find orphans by entity. */
    linkedEntityType: varchar('linked_entity_type', { length: 64 }),
    linkedEntityId: uuid('linked_entity_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  },
  (t) => ({
    statusIdx: index('ix_stored_file_status').on(t.status),
    uploaderIdx: index('ix_stored_file_uploader').on(t.uploaderId),
    entityIdx: index('ix_stored_file_entity').on(t.linkedEntityType, t.linkedEntityId),
    createdIdx: index('ix_stored_file_created').on(t.createdAt),
  }),
);

/**
 * attachments — the link between an owning entity and the files hanging off it.
 *
 * WHY A LINK TABLE WHEN `stored_files` ALREADY HAS `linked_entity_type/id`
 * ----------------------------------------------------------------------
 * Those two columns are cleanup bookkeeping: they let the orphan reaper correlate a pending row
 * with whatever was being edited. They cannot express OWNERSHIP, because they are single-valued —
 * one file, one entity, forever.
 *
 * That was enough while every surface was 1:1 and stored its key straight on the domain row
 * (`employees.photo_storage_key`, `assets.photo_storage_key`,
 * `leave_requests.document_storage_key`). Training certificates are the first surface that
 * ACCUMULATES: one completed course can be evidenced by a certificate and a transcript and a
 * score report. Adding `certificate_2_storage_key` is the shape this table exists to avoid.
 *
 * The 1:1 surfaces are deliberately NOT migrated onto this table. Their key column IS the
 * relationship — there is no list to page, no quota to enforce, and no second file to name — so
 * moving them would add a join to every avatar render in exchange for uniformity alone.
 *
 * Polymorphic on `(entity_type, entity_id)`, following rova's `work.attachments`: `entity_id`
 * carries no FK because it cannot point at two tables, which is the standing cost of this shape.
 * `file_id` DOES cascade, so deleting the file drops its links. Deleting the owning entity is the
 * owning service's job, and the reaper collects files nothing references.
 */
export const attachments = storageSchema.table(
  'attachments',
  {
    /** The kind of thing that owns the file, e.g. `training_record`. */
    entityType: varchar('entity_type', { length: 64 }).notNull(),
    entityId: uuid('entity_id').notNull(),
    fileId: uuid('file_id')
      .notNull()
      .references(() => storedFiles.id, { onDelete: 'cascade' }),
    attachedBy: uuid('attached_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    /** Natural key: the same file attached twice to one entity is still one attachment. */
    pk: primaryKey({ columns: [t.entityType, t.entityId, t.fileId] }),
    entityIdx: index('ix_attachment_entity').on(t.entityType, t.entityId),
    /** Drives the reaper's "is this file still referenced?" question. */
    fileIdx: index('ix_attachment_file').on(t.fileId),
  }),
);
