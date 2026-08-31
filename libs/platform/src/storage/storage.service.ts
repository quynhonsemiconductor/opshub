import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable, Logger } from '@nestjs/common';
import { eq, and, desc, lt } from 'drizzle-orm';
import { InjectDrizzle, type DrizzleDB } from '../database/index';
import { AppConfigService } from '../config/app-config.service';
import { ResilienceService } from '../resilience/resilience.service';
import { NotFoundException, ValidationException } from '../errors/exceptions';
import { ErrorCodes } from '../errors/error-codes';
import { Span } from '@qnsc-vn/observability';
import { storedFiles } from '../../../../db/schema';
import { newId } from '../../../shared-kernel/src/index';
import type {
  StoredFile,
  PresignUploadInput,
  PresignUploadResult,
  ConfirmUploadResult,
} from './storage.types';
import {
  RESOURCE_RULES,
  UPLOAD_URL_TTL_SECONDS,
  DOWNLOAD_URL_TTL_SECONDS,
  ORPHAN_CUTOFF_HOURS,
} from './storage.types';
import { MS_PER_HOUR } from '@shared-kernel';

/** Base64 SHA-256 is always 44 chars ending in '='. */
const BASE64_SHA256 = /^[A-Za-z0-9+/]{43}=$/;

/**
 * Platform-level storage service — S3 presigned PUT/GET + DB lifecycle tracking.
 *
 * Flow:
 *   1. presignUpload()  — validate, create storedFile(pending), return S3 PUT URL
 *   2. client PUTs file directly to S3 using the signed URL
 *   3. confirmUpload()  — HeadObject, verify size, update storedFile(completed)
 *   4. getDownloadUrl() — presignGet for time-limited read access
 *   5. deleteFile()     — soft-delete DB row + best-effort S3 delete
 *
 * Registered as a global provider via PlatformModule.
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly s3: S3Client;
  private readonly bucket: string;
  private readonly cdnBaseUrl: string | null;

  constructor(
    @InjectDrizzle() private readonly db: DrizzleDB,
    private readonly config: AppConfigService,
    private readonly resilience: ResilienceService,
  ) {
    this.bucket = config.get('S3_FILES_BUCKET') ?? '';
    this.cdnBaseUrl = (config.get('CDN_FILES_BASE_URL') ?? '').replace(/\/$/, '') || null;

    // endpoint set → S3-compatible backend (Cloudflare R2, MinIO) with static
    // credentials and path-style addressing. Same SDK, selected by config.
    const endpoint = config.get('STORAGE_ENDPOINT');
    const accessKeyId = config.get('STORAGE_ACCESS_KEY_ID');
    const secretAccessKey = config.get('STORAGE_SECRET_ACCESS_KEY');

    this.s3 = new S3Client({
      region: endpoint ? 'auto' : config.get('AWS_REGION'),
      ...(endpoint ? { endpoint, forcePathStyle: config.get('STORAGE_FORCE_PATH_STYLE') } : {}),
      ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {}),
    });
  }

  /**
   * Step 1: Validate the upload request, record a pending DB row, and return a
   * presigned S3 PUT URL.  The client should PUT the file to `uploadUrl` within
   * UPLOAD_URL_TTL_SECONDS (5 min).
   */
  @Span('storage.presignUpload')
  async presignUpload(input: PresignUploadInput, uploaderId: string): Promise<PresignUploadResult> {
    const rules = RESOURCE_RULES[input.resourceType];
    if (!rules) {
      throw new ValidationException(
        ErrorCodes.FILE_TYPE_NOT_ALLOWED,
        `Unknown resource type: ${input.resourceType}`,
      );
    }

    if (!(rules.allowedMimeTypes as readonly string[]).includes(input.mimeType)) {
      throw new ValidationException(
        ErrorCodes.FILE_TYPE_NOT_ALLOWED,
        `MIME type ${input.mimeType} not allowed for ${input.resourceType}. Allowed: ${rules.allowedMimeTypes.join(', ')}`,
      );
    }

    if (input.sizeBytes > rules.maxSizeBytes) {
      throw new ValidationException(
        ErrorCodes.FILE_TOO_LARGE,
        `File size ${input.sizeBytes} exceeds the ${rules.maxSizeBytes} byte limit for ${input.resourceType}`,
      );
    }

    if (input.checksumSha256 && !BASE64_SHA256.test(input.checksumSha256)) {
      throw new ValidationException(
        ErrorCodes.FILE_TYPE_NOT_ALLOWED,
        'checksumSha256 must be a base64-encoded SHA-256 digest',
      );
    }

    const ext = input.fileName.includes('.')
      ? `.${input.fileName.split('.').pop()!.toLowerCase()}`
      : '';
    const key = `${input.resourceType}/${uploaderId}/${newId()}${ext}`;
    const disposition = contentDisposition(input.fileName, rules.inlineDisposition);

    const [file] = await this.db
      .insert(storedFiles)
      .values({
        id: newId(),
        key,
        originalName: input.fileName,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        resourceType: input.resourceType,
        checksumSha256: input.checksumSha256 ?? null,
        status: 'pending',
        uploaderId,
        linkedEntityType: input.linkedEntityType ?? null,
        linkedEntityId: input.linkedEntityId ?? null,
      })
      .returning();

    const uploadUrl = await this.resilience.execute('s3.presignPut', this.resilience.external, () =>
      getSignedUrl(
        this.s3,
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          ContentType: input.mimeType,
          ContentLength: input.sizeBytes,
          ContentDisposition: disposition,
        }),
        {
          expiresIn: UPLOAD_URL_TTL_SECONDS,
          /**
           * The disposition has to be SIGNED for the client to be able to send it, and it has to be
           * sent for the object to carry it.
           *
           * A presigned PUT stores only what the request actually contains: a header named in the
           * command but absent from `signableHeaders` is dropped by the presigner and the upload
           * lands with no disposition at all — verified against LocalStack, where `head-object`
           * reported `ContentType` and no `ContentDisposition` until this list grew.
           *
           * This is where opshub deviates from rally, deliberately. Rally applies the disposition as
           * a RESPONSE OVERRIDE on its presigned GET, which works because it serves private objects
           * through that GET. `resolveUrl` here prefers `CDN_FILES_BASE_URL` whenever one is
           * configured, and a plain CDN read carries no response overrides — so the override alone
           * would silently not apply on the path production uses. Stored metadata travels with the
           * object however it is fetched.
           *
           * `x-amz-*` headers cannot be added this way: rally documented that the presigner ignores
           * them, the client then sends a header the signature does not cover, and S3 answers 403
           * with no CORS headers — which the browser surfaces as an opaque "Failed to fetch".
           */
          signableHeaders: new Set(['content-type', 'content-length', 'content-disposition']),
        },
      ),
    );

    // EXACTLY the headers the signature covers. The client must send all of them and nothing extra:
    // fewer fails the signature, and so does more.
    return {
      fileId: file.id,
      uploadUrl,
      key,
      requiredHeaders: {
        'Content-Type': input.mimeType,
        'Content-Disposition': disposition,
      },
    };
  }

  /**
   * Step 3: Verify the file was actually uploaded (HeadObject) and mark it
   * completed.  Idempotent — returns current state if already confirmed.
   */
  @Span('storage.confirmUpload')
  async confirmUpload(fileId: string, uploaderId: string): Promise<ConfirmUploadResult> {
    const [file] = await this.db
      .select()
      .from(storedFiles)
      .where(and(eq(storedFiles.id, fileId), eq(storedFiles.uploaderId, uploaderId)))
      .limit(1);

    if (!file) {
      throw new NotFoundException(ErrorCodes.FILE_NOT_FOUND, 'Stored file not found');
    }

    // Idempotent — already confirmed
    if (file.status === 'completed') {
      return { fileId: file.id, key: file.key, url: await this.resolveUrl(file.key) };
    }

    if (file.status === 'deleted') {
      throw new ValidationException(ErrorCodes.FILE_NOT_FOUND, 'This file has been deleted');
    }

    const head = await this.headObject(file.key);
    if (!head) {
      throw new ValidationException(
        ErrorCodes.FILE_NOT_UPLOADED,
        'File not found in storage. Upload the file to the presigned URL first.',
      );
    }

    if (head.contentLength !== file.sizeBytes) {
      // Size mismatch — mark deleted so the orphan cron can purge the S3 object
      await this.db
        .update(storedFiles)
        .set({ status: 'deleted' })
        .where(eq(storedFiles.id, fileId));
      throw new ValidationException(
        ErrorCodes.FILE_SIZE_MISMATCH,
        `Uploaded size (${head.contentLength}) does not match declared size (${file.sizeBytes})`,
      );
    }

    // Opportunistic: nothing enforces a checksum at PUT time and only some backends report a
    // stored one, but when both sides have a value it is the only check that catches a
    // same-length substitution — which the size comparison above cannot.
    if (head.checksumSha256 && file.checksumSha256 && head.checksumSha256 !== file.checksumSha256) {
      await this.db
        .update(storedFiles)
        .set({ status: 'deleted' })
        .where(eq(storedFiles.id, fileId));
      throw new ValidationException(
        ErrorCodes.FILE_CHECKSUM_MISMATCH,
        'Uploaded file does not match the declared checksum',
      );
    }

    const [updated] = await this.db
      .update(storedFiles)
      .set({
        status: 'completed',
        confirmedAt: new Date(),
        checksumSha256: file.checksumSha256 ?? head.checksumSha256 ?? null,
      })
      .where(eq(storedFiles.id, fileId))
      .returning();

    return { fileId: updated.id, key: updated.key, url: await this.resolveUrl(updated.key) };
  }

  /**
   * Get a time-limited download URL.  Uses CDN base URL when configured,
   * otherwise falls back to a presigned S3 GET URL (15 min TTL).
   */
  @Span('storage.getDownloadUrl')
  async getDownloadUrl(fileId: string): Promise<string> {
    const [file] = await this.db
      .select()
      .from(storedFiles)
      .where(and(eq(storedFiles.id, fileId), eq(storedFiles.status, 'completed')))
      .limit(1);

    if (!file) {
      throw new NotFoundException(ErrorCodes.FILE_NOT_FOUND, 'File not found or not yet confirmed');
    }

    return this.resolveUrl(file.key);
  }

  /**
   * Soft-delete the DB row and best-effort delete from S3.
   * S3 delete errors are logged but NOT re-thrown — the DB row is already gone.
   */
  @Span('storage.deleteFile')
  async deleteFile(fileId: string, uploaderId: string): Promise<void> {
    const [file] = await this.db
      .select()
      .from(storedFiles)
      .where(and(eq(storedFiles.id, fileId), eq(storedFiles.uploaderId, uploaderId)))
      .limit(1);

    if (!file) {
      throw new NotFoundException(ErrorCodes.FILE_NOT_FOUND, 'Stored file not found');
    }

    await this.db.update(storedFiles).set({ status: 'deleted' }).where(eq(storedFiles.id, fileId));

    void this.s3
      .send(new DeleteObjectCommand({ Bucket: this.bucket, Key: file.key }))
      .catch((err: unknown) =>
        this.logger.error({ key: file.key, err }, 'S3 delete failed — manual cleanup needed'),
      );
  }

  /**
   * Purge orphaned pending uploads older than ORPHAN_CUTOFF_HOURS hours.
   * Called by StorageCleanupCron — returns number of rows deleted.
   */
  async purgeOrphanedUploads(): Promise<number> {
    const cutoff = new Date(Date.now() - ORPHAN_CUTOFF_HOURS * MS_PER_HOUR);
    const rows = await this.db
      .select({ id: storedFiles.id, key: storedFiles.key })
      .from(storedFiles)
      .where(and(eq(storedFiles.status, 'pending'), lt(storedFiles.createdAt, cutoff)));

    if (rows.length === 0) return 0;

    // Best-effort S3 deletes — do not block on individual failures
    await Promise.allSettled(
      rows.map((r) =>
        this.s3
          .send(new DeleteObjectCommand({ Bucket: this.bucket, Key: r.key }))
          .catch((err: unknown) =>
            this.logger.warn({ key: r.key, err }, 'Orphan S3 delete failed'),
          ),
      ),
    );

    await this.db
      .update(storedFiles)
      .set({ status: 'deleted' })
      .where(and(eq(storedFiles.status, 'pending'), lt(storedFiles.createdAt, cutoff)));

    return rows.length;
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  /**
   * `interactive`, NOT `external`, and this is the only S3 call in this file that changed.
   *
   * This is the one place where a user-waiting HTTP request makes a real network round trip
   * to S3: `confirmUpload` awaits it, and `confirmUpload` is reached from live routes —
   * `POST /v1/assets/:id/photo/confirm` → `AssetService.confirmPhoto`
   * (`libs/modules/assets/src/interface/http/assets.controller.ts:222`), and the equivalent
   * confirm paths in identity, workforce and training. Under `external` a downstream blip
   * made that request take up to ~41 s (four attempts of 10 s plus backoff — see the
   * `maxAttempts` note in ResilienceService), and because the failure is reported as a 4xx
   * the 5xx alert never saw it. `interactive` bounds it at ~6.2 s.
   *
   * The presign call sites in this file (`s3.presignPut`, `s3.presignGet`) DELIBERATELY keep
   * `external`, even though they are on the same request paths. `getSignedUrl` signs
   * locally: it performs no request to S3, so there is no round trip for a tighter timeout
   * to bound and no latency to win. The only I/O it can reach is one-time credential
   * resolution against the ECS credential endpoint, which is cached for the rest of the
   * process's life. Tightening those would trade a real cold-start failure mode for nothing
   * measurable, which is the opposite of the trade being made here.
   */
  private async headObject(
    key: string,
  ): Promise<{ contentLength: number; checksumSha256: string | null } | null> {
    try {
      const result = await this.resilience.execute(
        's3.headObject',
        this.resilience.interactive,
        () =>
          this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key })),
      );
      return {
        contentLength: result.ContentLength ?? 0,
        // Present only when the object was PUT with a checksum; absent on R2 and MinIO.
        checksumSha256: result.ChecksumSHA256 ?? null,
      };
    } catch {
      return null;
    }
  }

  /**
   * A URL the caller can fetch the object with.
   *
   * `async`, and that is a FIX rather than a refactor: this used to end in
   * `getSignedUrl(...) as unknown as string`. `getSignedUrl` returns `Promise<string>`, so the
   * assertion silenced the compiler and every caller serialised a pending Promise instead of a
   * URL — on the exact path used when a bucket is configured and `CDN_FILES_BASE_URL` is not.
   * Local development never saw it because an unset bucket takes the placeholder branch above.
   */
  private async resolveUrl(key: string): Promise<string> {
    if (this.cdnBaseUrl) {
      return `${this.cdnBaseUrl}/${key}`;
    }
    // In dev we return a placeholder path, since S3_FILES_BUCKET may not be configured.
    if (!this.bucket) return `/dev/files/${key}`;
    return this.resilience.execute('s3.presignGet', this.resilience.external, () =>
      getSignedUrl(this.s3, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
        expiresIn: DOWNLOAD_URL_TTL_SECONDS,
      }),
    );
  }

  /** Presigned GET URL for a known key — used by domain services that already hold the key. */
  async presignGet(key: string): Promise<string> {
    if (this.cdnBaseUrl) return `${this.cdnBaseUrl}/${key}`;
    if (!this.bucket) return `/dev/files/${key}`;
    return this.resilience.execute('s3.presignGet', this.resilience.external, () =>
      getSignedUrl(this.s3, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
        expiresIn: DOWNLOAD_URL_TTL_SECONDS,
      }),
    );
  }

  /** Expose a stored file record by id (for domain services to link after confirm). */
  async findById(fileId: string): Promise<StoredFile | null> {
    const [row] = await this.db
      .select()
      .from(storedFiles)
      .where(eq(storedFiles.id, fileId))
      .limit(1);
    return row ?? null;
  }

  /**
   * The same, by S3 KEY — which is what the 1:1 surfaces actually hold.
   *
   * WHY THIS EXISTS. `employees.photo_storage_key`, `assets.photo_storage_key` and
   * `leave_requests.document_storage_key` store the KEY, not the file id, and four call sites passed
   * that key to `findById`. The column is a uuid, so Postgres answered
   * `invalid input syntax for type uuid: "employee-avatar/…/019ff.png"` — a 500 on every REPLACEMENT
   * upload, while the first upload for an entity worked because the old-file branch was skipped. Found by
   * driving the widget twice against the running API.
   *
   * Newest first: the key is unique per object in practice, but nothing in the schema says so, and a
   * cleanup that ever re-created one must not make this ambiguous.
   */
  async findByKey(key: string): Promise<StoredFile | null> {
    const [row] = await this.db
      .select()
      .from(storedFiles)
      .where(eq(storedFiles.key, key))
      .orderBy(desc(storedFiles.createdAt), desc(storedFiles.id))
      .limit(1);
    return row ?? null;
  }
}

/**
 * RFC 6266 `Content-Disposition`, defaulting to `attachment`.
 *
 * `attachment` makes a file inert in the browser whatever its bytes turn out to be, which matters
 * because MIME is client-declared: a file announcing `image/png` can contain script. Only surfaces
 * that must render — avatars, asset photos — opt into `inline`, and they pay for it by accepting
 * raster MIME types only.
 *
 * The filename is quoted and stripped of quotes, backslashes and control characters: it is
 * user-supplied text going into a response header, and a bare `"` would end the parameter early.
 */
function contentDisposition(filename: string, inline: boolean): string {
  // Stripping control characters IS the point: this value goes into an HTTP header, where a raw CR
  // or LF would split it into two.
  // eslint-disable-next-line no-control-regex
  const safe = filename.replace(/[\\"\r\n\u0000-\u001f]/g, '_').slice(0, 200);
  return `${inline ? 'inline' : 'attachment'}; filename="${safe}"`;
}
