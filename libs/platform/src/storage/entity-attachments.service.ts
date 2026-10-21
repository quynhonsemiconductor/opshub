import { Injectable, Logger } from '@nestjs/common';
import { and, asc, count, eq } from 'drizzle-orm';
import { InjectDrizzle, type DrizzleDB } from '../database/index';
import {
  NotFoundException,
  PermissionDeniedException,
  PreconditionFailedException,
} from '../errors/exceptions';
import { ErrorCodes } from '../errors/error-codes';
import { attachments, storedFiles } from '../../../../db/schema';
import { StorageService } from './storage.service';
import { RESOURCE_RULES, type ResourceType } from './storage.types';

/** Which entity owns the files — the first half of the link table's natural key. */
export interface AttachmentRef {
  entityType: string;
  entityId: string;
}

export interface EntityAttachment {
  fileId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  checksumSha256: string | null;
  uploadedBy: string;
  attachedBy: string;
  attachedAt: Date;
}

/**
 * Attachment mechanics for any entity that can own several files.
 *
 * MECHANICS HERE, AUTHORIZATION IN THE OWNING MODULE — rova's split, and the reason it exists:
 * the key layout, the quota, presign, confirm and unlink are identical for every surface, while
 * "may this actor attach to this thing?" depends on the owning context's permission model. So this
 * service never resolves a permission from an entity type and never loads a training record. Its
 * callers prove the subject exists, prove the actor may touch it, and delegate here.
 *
 * That is deliberate rather than lazy: an `entityType → permission` map inside here is exactly
 * where cross-entity authorization bugs hide — a new surface added to the map inherits whatever
 * the nearest entry happened to require.
 *
 * WHY THE QUOTA IS CHECKED TWICE. Presign reserves a row; confirm is where the file becomes
 * visible. N concurrent presigns can each pass a check against the same count, so the limit has to
 * hold at the point of visibility, and a file that arrives over the line is discarded rather than
 * linked.
 */
@Injectable()
export class EntityAttachmentsService {
  private readonly logger = new Logger(EntityAttachmentsService.name);

  constructor(
    @InjectDrizzle() private readonly db: DrizzleDB,
    private readonly storage: StorageService,
  ) {}

  /** Completed files attached to one entity, oldest first. */
  async list(ref: AttachmentRef): Promise<EntityAttachment[]> {
    const rows = await this.db
      .select({
        fileId: storedFiles.id,
        fileName: storedFiles.originalName,
        mimeType: storedFiles.mimeType,
        sizeBytes: storedFiles.sizeBytes,
        checksumSha256: storedFiles.checksumSha256,
        uploadedBy: storedFiles.uploaderId,
        attachedBy: attachments.attachedBy,
        attachedAt: attachments.createdAt,
      })
      .from(attachments)
      .innerJoin(storedFiles, eq(storedFiles.id, attachments.fileId))
      .where(
        and(
          eq(attachments.entityType, ref.entityType),
          eq(attachments.entityId, ref.entityId),
          // A pending or discarded row is not an attachment anyone can open.
          eq(storedFiles.status, 'completed'),
        ),
      )
      // `created_at` is not unique — two files attached in one request share it — so `file_id`
      // is the tiebreaker that keeps this a total order.
      .orderBy(asc(attachments.createdAt), asc(attachments.fileId));
    return rows;
  }

  async count(ref: AttachmentRef): Promise<number> {
    const [row] = await this.db
      .select({ n: count() })
      .from(attachments)
      .innerJoin(storedFiles, eq(storedFiles.id, attachments.fileId))
      .where(
        and(
          eq(attachments.entityType, ref.entityType),
          eq(attachments.entityId, ref.entityId),
          eq(storedFiles.status, 'completed'),
        ),
      );
    return Number(row?.n ?? 0);
  }

  /**
   * Reserve a file for this entity and mint the presigned PUT.
   *
   * The quota is counted here so a caller cannot exceed it by accident, and again on confirm so a
   * caller cannot exceed it by racing.
   */
  async presign(
    ref: AttachmentRef,
    resourceType: ResourceType,
    input: {
      fileName: string;
      mimeType: string;
      sizeBytes: number;
      checksumSha256?: string;
    },
    uploaderId: string,
  ): Promise<{ fileId: string; uploadUrl: string; requiredHeaders: Record<string, string> }> {
    await this.assertRoom(ref, resourceType);

    const { fileId, uploadUrl, requiredHeaders } = await this.storage.presignUpload(
      {
        ...input,
        resourceType,
        // Recorded so the orphan reaper can correlate a never-confirmed upload with what was being
        // edited at the time.
        linkedEntityType: ref.entityType,
        linkedEntityId: ref.entityId,
      },
      uploaderId,
    );
    return { fileId, uploadUrl, requiredHeaders };
  }

  /**
   * Verify the object landed, then link it to the entity — one transaction.
   *
   * Returns the attachment so the caller can answer with it directly.
   */
  async confirm(
    ref: AttachmentRef,
    resourceType: ResourceType,
    fileId: string,
    uploaderId: string,
  ): Promise<EntityAttachment> {
    // Checks the object exists and matches the declared size and checksum.
    await this.storage.confirmUpload(fileId, uploaderId);

    const file = await this.storage.findById(fileId);
    if (!file) throw new NotFoundException(ErrorCodes.FILE_NOT_FOUND, 'Stored file not found');

    // Re-checked at the point of visibility — see the class comment. Over the line, the file is
    // discarded rather than left dangling as a completed-but-unlinked row the reaper would keep.
    try {
      await this.assertRoom(ref, resourceType);
    } catch (err) {
      await this.storage.deleteFile(fileId, uploaderId);
      throw err;
    }

    await this.db
      .insert(attachments)
      .values({
        entityType: ref.entityType,
        entityId: ref.entityId,
        fileId,
        attachedBy: uploaderId,
      })
      // The natural key makes a repeated confirm idempotent rather than a 500.
      .onConflictDoNothing();

    this.logger.log({ ...ref, fileId, fileName: file.originalName }, 'Attachment confirmed');

    return {
      fileId: file.id,
      fileName: file.originalName,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
      checksumSha256: file.checksumSha256,
      uploadedBy: file.uploaderId,
      attachedBy: uploaderId,
      attachedAt: new Date(),
    };
  }

  /**
   * A time-limited URL for one attachment.
   *
   * The link row is checked FIRST: without it, any caller authorized on ANY entity of this type
   * could pass any file id and get a URL for it. The id is the capability, so the ownership check
   * is the authorization.
   */
  async downloadUrl(ref: AttachmentRef, fileId: string): Promise<string> {
    await this.requireLink(ref, fileId);
    return this.storage.getDownloadUrl(fileId);
  }

  /**
   * Unlink a file from an entity and soft-delete it.
   *
   * `deletedBy` must be the uploader unless `force` is set, which is how the owning module applies
   * its own "or a manager" rule without this service knowing what a manager is.
   */
  async remove(
    ref: AttachmentRef,
    fileId: string,
    deletedBy: string,
    force = false,
  ): Promise<void> {
    const file = await this.requireLink(ref, fileId);

    if (!force && file.uploaderId !== deletedBy) {
      /*
       * 403, NOT 412. This threw `PreconditionFailedException(ErrorCodes.FORBIDDEN, …)` — a response
       * that contradicted itself: the status said "a precondition on this request failed", which
       * invites the caller to change something and retry, while the code said `FORBIDDEN`, which
       * means no retry will help. A client mapping 403 to "you are not allowed to do that" showed a
       * generic failure instead.
       */
      throw new PermissionDeniedException('Only the uploader may remove this file');
    }

    await this.db
      .delete(attachments)
      .where(
        and(
          eq(attachments.entityType, ref.entityType),
          eq(attachments.entityId, ref.entityId),
          eq(attachments.fileId, fileId),
        ),
      );
    // Soft-delete plus a best-effort object delete. `force` here because the link check above has
    // already established who may act, and `deleteFile`'s own uploader check would otherwise
    // refuse a manager the owning module just authorized.
    await this.storage.deleteFile(fileId, file.uploaderId);
  }

  /** Every link row for an entity — used when the owning row itself is deleted. */
  async removeAll(ref: AttachmentRef, actorId: string): Promise<number> {
    const existing = await this.list(ref);
    for (const attachment of existing) {
      await this.remove(ref, attachment.fileId, actorId, true);
    }
    return existing.length;
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  private async assertRoom(ref: AttachmentRef, resourceType: ResourceType): Promise<void> {
    const limit = RESOURCE_RULES[resourceType].maxPerOwner;
    if (limit === null) return;

    const current = await this.count(ref);
    if (current >= limit) {
      throw new PreconditionFailedException(
        ErrorCodes.ATTACHMENT_LIMIT_EXCEEDED,
        `This ${ref.entityType.replace(/_/g, ' ')} already has the maximum of ${limit} files`,
      );
    }
  }

  private async requireLink(ref: AttachmentRef, fileId: string) {
    const [row] = await this.db
      .select({ file: storedFiles })
      .from(attachments)
      .innerJoin(storedFiles, eq(storedFiles.id, attachments.fileId))
      .where(
        and(
          eq(attachments.entityType, ref.entityType),
          eq(attachments.entityId, ref.entityId),
          eq(attachments.fileId, fileId),
        ),
      )
      .limit(1);

    if (!row) {
      throw new NotFoundException(
        ErrorCodes.ATTACHMENT_NOT_FOUND,
        'That file is not attached to this record',
      );
    }
    return row.file;
  }
}
