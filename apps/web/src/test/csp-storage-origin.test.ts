/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { describe, expect, it } from 'vitest';

/**
 * The SPA talks to object storage DIRECTLY, so the Content-Security-Policy is the thing
 * that decides whether uploads and attachments work at all:
 *
 *   - the upload widget PUTs the bytes to a presigned URL (use-upload.ts), a cross-origin
 *     fetch, which `connect-src` governs;
 *   - attachments and avatars render from presigned GETs, which `img-src` governs.
 *
 * The presigned URL's host is whatever `STORAGE_ENDPOINT` says, and every deployed
 * environment (dev and prod) sets it to the same account-scoped R2 S3 endpoint
 * (gitops `values/opshub/{dev,prod}.yaml`). Until 2026-11-03 the policy listed only the
 * AWS S3 hosts, so EVERY deployed upload was blocked by CSP — silently, because the
 * browser reports a CSP refusal as a generic `Failed to fetch`.
 *
 * This test derives the origin the code actually signs, from the same SDK calls
 * StorageService makes (`libs/platform/src/storage/storage.service.ts`: endpoint +
 * forcePathStyle), and requires it in BOTH directives of BOTH files. It also holds the
 * two files byte-identical for this header: `scripts/web-image-test.sh` compares the
 * Caddy image against `_headers`, and a drift between them would make the image and the
 * Worker apply different policies.
 */

/** Mirrors STORAGE_ENDPOINT in gitops values/opshub/{dev,prod}.yaml, forcePathStyle true. */
const STORAGE_ENDPOINT = 'https://69e52835cf2d08edde5b6ebd741d30fa.r2.cloudflarestorage.com';

/** The buckets each environment stores to; only the PATH differs, the origin must not. */
const BUCKETS = ['opshub-develop-attachments', 'opshub-prod-attachments'];

/** Fake credentials: presigning signs locally, so no network and no real secret is involved. */
const s3 = new S3Client({
  region: 'auto',
  endpoint: STORAGE_ENDPOINT,
  forcePathStyle: true,
  credentials: { accessKeyId: 'test-access-key', secretAccessKey: 'test-secret-key' },
});

const webRoot = resolve(import.meta.dirname, '../..');

function readCspFromHeadersFile(): string {
  const raw = readFileSync(resolve(webRoot, 'public/_headers'), 'utf8');
  const line = raw.split('\n').find((l) => /^\s*Content-Security-Policy:\s*\S/.test(l));
  if (!line) throw new Error('no Content-Security-Policy line in public/_headers');
  return line.replace(/^\s*Content-Security-Policy:\s*/, '').trim();
}

function readCspFromCaddyfile(): string {
  const raw = readFileSync(resolve(webRoot, 'Caddyfile'), 'utf8');
  const match = raw.match(/^\s*Content-Security-Policy "([^"]+)"/m);
  if (!match) throw new Error('no Content-Security-Policy header in Caddyfile');
  return match[1]!.trim();
}

/** `connect-src 'self' https://host` → `connect-src` → ['self', 'https://host']. */
function directives(csp: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const part of csp.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) out.set(name, sources);
  }
  return out;
}

async function presignedGetOrigin(bucket: string): Promise<string> {
  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: bucket, Key: 'attachment/user/file.pdf' }),
    { expiresIn: 300 },
  );
  return new URL(url).origin;
}

describe('the web Content-Security-Policy allows the presigned storage origin', () => {
  const headersCsp = readCspFromHeadersFile();
  const caddyCsp = readCspFromCaddyfile();

  it('keeps the Caddy image and the Worker manifest on the same policy', () => {
    expect(caddyCsp).toBe(headersCsp);
  });

  it('signs URLs against the account-scoped R2 host, path-style, for both environments', async () => {
    for (const bucket of BUCKETS) {
      const put = await getSignedUrl(
        s3,
        new PutObjectCommand({ Bucket: bucket, Key: 'attachment/user/file.pdf' }),
        { expiresIn: 300 },
      );
      const url = new URL(put);
      expect(url.origin).toBe(STORAGE_ENDPOINT);
      // Path-style: the bucket is a path segment, so the policy needs the endpoint host only.
      expect(url.pathname.startsWith(`/${bucket}/`)).toBe(true);

      // A download signs the same origin; only the method and the query differ.
      expect(await presignedGetOrigin(bucket)).toBe(url.origin);
    }
  });

  it.each([
    ['public/_headers', () => headersCsp],
    ['Caddyfile', () => caddyCsp],
  ])(
    '%s lists that origin in connect-src (uploads) and img-src (attachments)',
    async (_name, cspOf) => {
      const csp = directives(cspOf());
      expect(csp.get('connect-src')).toContain(STORAGE_ENDPOINT);
      expect(csp.get('img-src')).toContain(STORAGE_ENDPOINT);
      // 'self' must stay: the SPA's own API calls are same-origin.
      expect(csp.get('connect-src')).toContain("'self'");
    },
  );

  it.each([
    ['public/_headers', () => headersCsp],
    ['Caddyfile', () => caddyCsp],
  ])('%s no longer names the retired AWS S3 hosts', (_name, cspOf) => {
    expect(cspOf()).not.toMatch(/amazonaws\.com/);
  });
});
