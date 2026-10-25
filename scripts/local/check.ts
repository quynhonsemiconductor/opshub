/**
 * `pnpm local:check`: proves the local stack works from a clean start, end to end, through the same doors the app uses.
 *
 *   1. API probes         GET /readyz on the API port answers 200.
 *   2. Worker             the worker writes a beat to Valkey every 30 s under worker:heartbeat:<host>; a fresh beat proves a live worker.
 *   3. Sign-in            POST /api/auth/test-login through the web dev server's proxy, then GET /v1/auth/me with that session.
 *   4. Storage            a marker object round-trips through Garage (write, then read back). It does not restart anything, so it does
 *                         not prove persistence across a restart; that is a separate, manual check (see README → "Local stack").
 *   5. Mail               a message sent through platform-mail's smtp transport (the one EMAIL_PROVIDER=smtp uses) lands in Mailpit.
 *
 * Writes only its own marker object and one test message. Exits 1 at the first failing step, naming it.
 */
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createEmailSender } from '@quynhonsemiconductor/platform-mail/sender';
import Redis from 'ioredis';
import {
  WORKER_HEARTBEAT_KEY_PREFIX,
  WORKER_HEARTBEAT_TTL_SECONDS,
} from '../../apps/worker/src/heartbeat/worker-heartbeat.constants';
import { randomUUID } from 'node:crypto';

process.loadEnvFile?.('.env');

const env = (key: string, fallback?: string): string => {
  const value = process.env[key] ?? fallback;
  if (value === undefined) throw new Error(`${key} is not set: copy .env.example to .env`);
  return value;
};

const API = `http://localhost:${env('PORT', '3001')}`;
const WEB = `http://localhost:${env('WEB_DEV_PORT', '5174')}`;
const MAILPIT = `http://localhost:${env('MAILPIT_UI_HOST_PORT', '8110')}`;
// The demo admin the seed creates (db/seed.ts, ADMIN_EMAIL's default). Sign-in needs SEED_ON_DEPLOY=true, which .env.example sets.
const TEST_LOGIN_EMAIL = 'admin@opshub.local';
const MARKER_KEY = 'local-check/round-trip-marker.txt';

class CheckFailed extends Error {}

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new CheckFailed(message);
}

async function step(name: string, fn: () => Promise<string>): Promise<void> {
  try {
    const detail = await fn();
    process.stdout.write(`ok      ${name}: ${detail}\n`);
  } catch (err) {
    process.stderr.write(`FAIL    ${name}: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  await step('api probes', async () => {
    const res = await fetch(`${API}/readyz`);
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    expect(
      res.status === 200,
      `GET ${API}/readyz answered ${res.status}; is the API running (make local starts it)?`,
    );
    return `readyz 200 (${JSON.stringify(body).slice(0, 120)})`;
  });

  await step('worker heartbeat', async () => {
    const redis = new Redis(env('VALKEY_URL', 'redis://localhost:6310'));
    try {
      const keys: string[] = [];
      let cursor = '0';
      do {
        const [next, batch] = await redis.scan(
          cursor,
          'MATCH',
          `*${WORKER_HEARTBEAT_KEY_PREFIX}*`,
          'COUNT',
          100,
        );
        cursor = next;
        keys.push(...batch);
      } while (cursor !== '0');
      expect(
        keys.length > 0,
        'no worker heartbeat key: is the worker running (make local starts it)?',
      );
      const beats = await Promise.all(keys.map(async (key) => ({ key, at: await redis.get(key) })));
      const fresh = beats.filter(
        (b) => b.at !== null && Date.now() - Date.parse(b.at) < WORKER_HEARTBEAT_TTL_SECONDS * 1000,
      );
      expect(fresh.length > 0, `heartbeat keys exist but none is fresh: ${keys.join(', ')}`);
      return `${fresh.length} live replica(s): ${fresh.map((f) => f.key).join(', ')}`;
    } finally {
      redis.disconnect();
    }
  });

  await step('sign-in through the web proxy', async () => {
    const login = await fetch(`${WEB}/api/auth/test-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: TEST_LOGIN_EMAIL }),
    });
    expect(
      login.ok,
      `POST test-login answered ${login.status}; is IDENTITY_TEST_LOGIN=enabled and the demo users seeded (SEED_ON_DEPLOY=true)?`,
    );
    const cookie = login.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ');
    expect(cookie.length > 0, 'test-login set no session cookie');
    const me = await fetch(`${WEB}/v1/auth/me`, { headers: { cookie } });
    expect(me.status === 200, `GET /v1/auth/me through the proxy answered ${me.status}`);
    const user = (await me.json()) as { email?: string };
    expect(
      user.email === TEST_LOGIN_EMAIL,
      `session belongs to ${user.email ?? 'nobody'}, not ${TEST_LOGIN_EMAIL}`,
    );
    return `signed in as ${TEST_LOGIN_EMAIL}`;
  });

  await step('storage round trip', async () => {
    // The client StorageService builds when STORAGE_ENDPOINT is set: the same endpoint, keys, path style and region ('auto'),
    // so a signing mismatch shows up here and not first in a browser upload.
    const s3 = new S3Client({
      endpoint: env('STORAGE_ENDPOINT'),
      region: 'auto',
      forcePathStyle: true,
      credentials: {
        accessKeyId: env('STORAGE_ACCESS_KEY_ID'),
        secretAccessKey: env('STORAGE_SECRET_ACCESS_KEY'),
      },
    });
    const Bucket = env('S3_FILES_BUCKET', 'opshub-files-dev');

    const marker = `${new Date().toISOString()} ${randomUUID()}`;
    await s3.send(
      new PutObjectCommand({ Bucket, Key: MARKER_KEY, Body: marker, ContentType: 'text/plain' }),
    );
    const back = await s3.send(new GetObjectCommand({ Bucket, Key: MARKER_KEY }));
    expect(
      (await back.Body?.transformToString()) === marker,
      'the marker read back is not the marker written',
    );
    return 'wrote and read back a marker';
  });

  await step('mail lands in Mailpit', async () => {
    const sender = createEmailSender({
      env: {
        MAIL_TRANSPORT: 'smtp',
        MAIL_SMTP_HOST: env('MAIL_SMTP_HOST', 'localhost'),
        MAIL_SMTP_PORT: env('MAIL_SMTP_PORT', '1110'),
        MAIL_SMTP_FROM: env('MAIL_FROM_EMAIL', 'noreply@qnsc.vn'),
        NODE_ENV: 'development',
      },
    });
    const nonce = randomUUID();
    const subject = `local check ${nonce}`;
    await sender.send({
      to: 'local-check@qnsc.vn',
      subject,
      html: `<p>${nonce}</p>`,
      text: nonce,
      category: 'local.check',
      idempotencyKey: nonce,
    });
    for (let attempt = 0; attempt < 15; attempt += 1) {
      const res = await fetch(`${MAILPIT}/api/v1/messages`);
      const list = (await res.json()) as { messages?: { Subject?: string }[] };
      if (list.messages?.some((m) => m.Subject === subject)) {
        return `delivered to Mailpit (${MAILPIT}) as "${subject}"`;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new CheckFailed(`the message did not appear in Mailpit at ${MAILPIT} within 15 seconds`);
  });

  process.stdout.write('all checked steps passed\n');
}

void main();
