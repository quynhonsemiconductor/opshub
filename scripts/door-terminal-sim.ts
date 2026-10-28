#!/usr/bin/env npx tsx
/**
 * `scripts/door-terminal-sim.ts` — a fake ESP32 terminal (ADR §5, phase 0).
 *
 * Polls the allow-list (honouring ETag/304 like the firmware will) and uploads one synthetic event
 * per tick, so UI work and e2e-style poking need no hardware. NOT a test: it talks to a real,
 * running API.
 *
 *   pnpm tsx scripts/door-terminal-sim.ts --url http://localhost:3001 --token <id>.<secret> [--once]
 *
 * `--once` performs one sync cycle and exits (what e2e-style checks use). Without it, it loops on
 * the terminal's 60 s cadence.
 */
import { randomUUID } from 'node:crypto';

// .env is OPTIONAL: the sim runs fine with only --url/--token flags.
try {
  process.loadEnvFile?.('.env');
} catch {
  /* no .env — flags carry everything */
}

const args = process.argv.slice(2);
function arg(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

const BASE_URL = arg('url') ?? `http://localhost:${process.env['PORT'] ?? '3001'}`;
const TOKEN = arg('token');
const ONCE = args.includes('--once');
const POLL_MS = 60_000;

if (!TOKEN || !TOKEN.includes('.')) {
  process.stderr.write(
    'usage: door-terminal-sim.ts --url <base> --token <terminal_id>.<secret> [--once]\n',
  );
  process.exit(1);
}

/** The stream uuid: what firmware keeps in NVS, the sim keeps in process memory. */
const stream = randomUUID();
let seq = Math.floor(Math.random() * 1000); // like firmware resuming past a reserved block
let etag: string | undefined;
let saw304 = false;

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${TOKEN}`, 'User-Agent': 'qnsc-door-terminal/sim', ...extra };
}

async function syncAllowList(): Promise<void> {
  const res = await fetch(`${BASE_URL}/v1/door/terminal/allow-list`, {
    headers: headers(etag ? { 'If-None-Match': etag } : {}),
  });
  if (res.status === 304) {
    if (!saw304) process.stdout.write('allow-list unchanged (304)' + '\n');
    saw304 = true;
    return;
  }
  if (!res.ok) {
    process.stderr.write(`allow-list failed: ${res.status} ${await res.text()}\n`);
    return;
  }
  saw304 = false;
  etag = res.headers.get('etag') ?? undefined;
  const body = (await res.json()) as {
    cards: { uid: string; valid_from: number | null; valid_until: number | null }[];
  };
  process.stdout.write(`allow-list: ${body.cards.length} card(s) ${JSON.stringify(body.cards)}\n`);
}

async function sendEvent(): Promise<void> {
  seq += 1;
  const event = {
    seq,
    reader: 'in',
    // A UID the door cannot know, so the event lands on the unknown-card list — visible end to end.
    uid: '04DEADBEEF01D3',
    result: 'deny',
    device_ts: new Date().toISOString(),
    time_synced: true,
  };
  const res = await fetch(`${BASE_URL}/v1/door/terminal/events`, {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ stream, dropped: 0, events: [event] }),
  });
  const body = await res.text();
  if (!res.ok) {
    process.stderr.write(`events failed: ${res.status} ${body}\n`);
    return;
  }
  process.stdout.write(`event acked: ${body}` + '\n');
}

async function cycle(): Promise<void> {
  // One network error must not kill the loop — the next tick retries (like the firmware does).
  try {
    await syncAllowList();
    await sendEvent();
  } catch (err) {
    process.stderr.write(`cycle failed: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

async function main(): Promise<void> {
  await cycle();
  if (!ONCE) {
    setInterval(() => void cycle(), POLL_MS);
    process.stdout.write(`simulating; every ${POLL_MS / 1000}s — Ctrl-C to stop\n`);
  }
}

void main();
