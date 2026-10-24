// One-shot setup of the local Garage node for CI: layout, the fixed local-dev key, the CI bucket,
// its grant, lifecycle and CORS. Port of scripts/garage/init.sh for the Playwright container job,
// which has no aws-cli and must not pip-install one (PEP 668) — the S3 calls run on
// @aws-sdk/client-s3, already a dependency, and the admin calls on global fetch (node 18+).
// Idempotent: every step checks before it changes anything. Exits non-zero on any failure.
//
// Endpoints are LOCALHOST: Garage runs as a background process inside the same job container
// (the static musl release binary, started with docker/garage/garage.toml). No hostnames, no keys
// beyond the fixed local-dev ones that docker-compose.dev.yml also carries in plain text.
import { S3Client, PutBucketCorsCommand, PutBucketLifecycleConfigurationCommand } from '@aws-sdk/client-s3';

const ADMIN = 'http://localhost:3903';
const S3 = 'http://localhost:3900';
const BUCKETS = process.env.BUCKETS ?? 'opshub-files-dev opshub-files-test';
const ORIGINS = (process.env.WEB_ORIGINS ?? 'http://localhost:5174,http://127.0.0.1:5174').split(',');
const ACCESS_KEY_ID = process.env.STORAGE_ACCESS_KEY_ID;
const SECRET = process.env.STORAGE_SECRET_ACCESS_KEY;

const api = async (path, init = {}) => {
  const res = await fetch(ADMIN + path, {
    ...init,
    // "Bearer " is required: the bare token gets 403 Forbidden ("Invalid authorization token").
    headers: { Authorization: `Bearer ${process.env.GARAGE_ADMIN_TOKEN}`, 'content-type': 'application/json', ...init.headers },
  });
  if (!res.ok) throw new Error(`Garage admin ${path} -> ${res.status}: ${await res.text()}`);
  return res.status === 204 ? null : res.json();
};

for (let i = 0; ; i++) {
  try {
    await api('/v1/status');
    break;
  } catch {
    if (i >= 30) { console.error('[garage-init] node did not answer'); process.exit(1); }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

const status = await api('/v1/status');
const layout = await api('/v1/layout');
if (layout.version === 0) {
  await api('/v1/layout', { method: 'POST', body: JSON.stringify([{ id: status.node, zone: 'dc1', capacity: 1073741824, tags: [] }]) });
  await api('/v1/layout/apply', { method: 'POST', body: JSON.stringify({ version: 1 }) });
  console.log('[garage-init]   layout applied');
}

if ((await fetch(`${ADMIN}/v1/key?id=${ACCESS_KEY_ID}`, { headers: { Authorization: `Bearer ${process.env.GARAGE_ADMIN_TOKEN}` } })).status !== 200) {
  await api('/v1/key/import', {
    method: 'POST',
    body: JSON.stringify({ name: 'local-dev', accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET }),
  });
  console.log('[garage-init]   key imported');
}

const s3 = new S3Client({
  region: 'auto',
  endpoint: S3,
  forcePathStyle: true,
  credentials: { accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET },
});

// CORS, one rule per origin: Garage joins origins in a single rule into one header, which browsers refuse. Garage compares the
// allowed header names case-sensitively against the lowercase names a browser sends, so they are written lowercase here. The list
// is every header the presigned PUT signs (StorageService.presignUpload): content-type and content-disposition.
const corsRules = ORIGINS.map((origin) => ({
  AllowedOrigins: [origin],
  AllowedMethods: ['PUT', 'GET', 'HEAD'],
  AllowedHeaders: ['content-type', 'content-disposition'],
  ExposeHeaders: ['ETag'],
  MaxAgeSeconds: 3600,
}));

// Abort incomplete multipart uploads after 7 days, as the AWS bucket does.
const lifecycle = {
  Rules: [{ ID: 'abort-incomplete-multipart', Status: 'Enabled', Filter: { Prefix: '' }, AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 } }],
};

for (const bucket of BUCKETS.split(/[\s,]+/).filter(Boolean)) {
  let bucketInfo;
  try {
    bucketInfo = await api(`/v1/bucket?globalAlias=${bucket}`);
  } catch {
    bucketInfo = await api('/v1/bucket', { method: 'POST', body: JSON.stringify({ globalAlias: bucket }) });
    console.log(`[garage-init]   bucket created: ${bucket}`);
  }
  await api('/v1/bucket/allow', {
    method: 'POST',
    body: JSON.stringify({ bucketId: bucketInfo.id, accessKeyId: ACCESS_KEY_ID, permissions: { read: true, write: true, owner: true } }),
  });
  await s3.send(new PutBucketCorsCommand({ Bucket: bucket, CORSConfiguration: { CORSRules: corsRules } }));
  await s3.send(new PutBucketLifecycleConfigurationCommand({ Bucket: bucket, LifecycleConfiguration: lifecycle }));
}

// Prove it, the way a browser asks: a preflight from each origin, for the headers the upload sends, must get that origin back.
for (const bucket of BUCKETS.split(/[\s,]+/).filter(Boolean)) {
  for (const origin of ORIGINS) {
    const preflight = await fetch(`${S3}/${bucket}/probe`, {
      method: 'OPTIONS',
      headers: { Origin: origin, 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'content-type,content-disposition' },
    });
    const got = preflight.headers.get('access-control-allow-origin');
    if (got !== origin) {
      console.error(`[garage-init] CORS check failed for ${bucket} from ${origin} (got '${got}')`);
      process.exit(1);
    }
  }
}
console.log(`[garage-init] ${BUCKETS} ready (buckets, key, lifecycle, CORS, preflight proven)`);
