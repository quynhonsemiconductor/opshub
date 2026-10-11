/**
 * The Intune device sync depends on nothing undocumented: it lists all managed devices with a plain
 * `$select`, compares `lastSyncDateTime` client-side, flags devices that went silent, survives a bad
 * device, and only advances its cursor after a pass in which nothing failed.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  DEVICE_FULL_PASS_STATE,
  DEVICE_SYNC_STATE,
  DeviceSyncService,
  STALE_AFTER_DAYS,
} from './device-sync.service';

const NOW = new Date('2026-10-11T12:00:00Z');
const DAY = 86_400_000;
const iso = (offsetMs: number) => new Date(NOW.getTime() + offsetMs).toISOString();

interface Opts {
  state?: Record<string, string>;
  pages: Array<{ value: unknown[]; '@odata.nextLink'?: string }>;
  existingSources?: Set<string>;
  failInsertFor?: string;
}

/** The bound value of an `eq(column, value)` condition. */
function paramOf(cond: { queryChunks?: unknown[] }): string | undefined {
  for (const chunk of cond.queryChunks ?? []) {
    const value = (chunk as { value?: unknown } | null)?.value;
    if (typeof value === 'string') return value;
  }
  return undefined;
}

function make(opts: Opts) {
  const urls: string[] = [];
  const pages = [...opts.pages];
  const api = vi.fn((url: string) => {
    urls.push(url);
    return { get: vi.fn(() => Promise.resolve(pages.shift())) };
  });
  const graph = { isEnabled: vi.fn().mockReturnValue(true), client: () => ({ api }) };

  const state = { ...(opts.state ?? {}) };
  const inserted: Array<Record<string, unknown>> = [];
  const saved: Array<{ name: string; cursor: string }> = [];
  let lastWhere: 'state' | 'finding' = 'state';

  const db = {
    select: vi.fn((cols: Record<string, unknown>) => {
      lastWhere = 'cursor' in cols ? 'state' : 'finding';
      return {
        from: vi.fn().mockReturnThis(),
        where: vi.fn((cond: { queryChunks?: unknown[] }) => ({
          limit: vi.fn(() => {
            const key = paramOf(cond);
            if (lastWhere === 'state') {
              return Promise.resolve(key && key in state ? [{ cursor: state[key] }] : []);
            }
            return Promise.resolve(key && opts.existingSources?.has(key) ? [{ id: 'x' }] : []);
          }),
        })),
      };
    }),
    insert: vi.fn(() => ({
      values: vi.fn((v: Record<string, unknown>) => {
        if ('source' in v) {
          if (opts.failInsertFor && String(v['source']).includes(opts.failInsertFor)) {
            return Promise.reject(new Error('value too long for type character varying(60)'));
          }
          inserted.push(v);
          return Promise.resolve();
        }
        return {
          onConflictDoUpdate: vi.fn(() => {
            saved.push({ name: v['name'] as string, cursor: v['cursor'] as string });
            return Promise.resolve();
          }),
        };
      }),
    })),
  };
  return {
    service: new DeviceSyncService(graph as never, db as never),
    urls,
    inserted,
    saved,
    graph,
  };
}

const device = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  deviceName: `host-${id}`,
  osVersion: '11.0',
  complianceState: 'compliant',
  isEncrypted: true,
  lastSyncDateTime: iso(-1 * 3600_000),
  ...over,
});

describe('DeviceSyncService', () => {
  it('lists with a plain $select — no $filter, no delta', async () => {
    const { service, urls } = make({ pages: [{ value: [] }] });

    await service.syncDevices(NOW);

    expect(urls).toHaveLength(1);
    expect(urls[0]).toMatch(/^\/deviceManagement\/managedDevices\?\$top=100&\$select=/);
    expect(urls[0]).not.toMatch(/filter|delta/i);
  });

  it('follows nextLink so every page of devices is evaluated', async () => {
    const { service, urls, inserted } = make({
      pages: [
        { value: [device('a', { isEncrypted: false })], '@odata.nextLink': '/next?page=2' },
        { value: [device('b', { complianceState: 'noncompliant' })] },
      ],
    });

    const result = await service.syncDevices(NOW);

    expect(urls).toEqual([expect.stringContaining('managedDevices'), '/next?page=2']);
    expect(result).toMatchObject({ devices: 2, findings: 2, errors: 0 });
    expect(inserted.map((r) => r['source'])).toEqual([
      'intune:a:unencrypted',
      'intune:b:noncompliant',
    ]);
  });

  it('flags a device that stopped checking in — silence is the worst news', async () => {
    const silent = device('old', { lastSyncDateTime: iso(-(STALE_AFTER_DAYS + 1) * DAY) });
    const { service, inserted } = make({ pages: [{ value: [silent] }] });

    await service.syncDevices(NOW);

    expect(inserted.map((r) => r['source'])).toEqual(['intune:old:stale']);
    expect(inserted[0]['severity']).toBe('medium');
  });

  it('does not flag a device that checked in recently', async () => {
    const { service, inserted } = make({ pages: [{ value: [device('fresh')] }] });
    await service.syncDevices(NOW);
    expect(inserted).toEqual([]);
  });

  it('skips re-evaluating a device that has not synced since the cursor (outside the daily full pass)', async () => {
    const unchanged = device('same', { isEncrypted: false, lastSyncDateTime: iso(-3 * DAY) });
    const { service, inserted } = make({
      state: {
        [DEVICE_SYNC_STATE]: iso(-1 * DAY),
        [DEVICE_FULL_PASS_STATE]: iso(-3600_000), // a full pass ran an hour ago
      },
      pages: [{ value: [unchanged] }],
    });

    await service.syncDevices(NOW);

    expect(inserted).toEqual([]);
  });

  it('evaluates EVERY device in the daily full pass, changed or not', async () => {
    const unchanged = device('same', { isEncrypted: false, lastSyncDateTime: iso(-3 * DAY) });
    const { service, inserted } = make({
      state: {
        [DEVICE_SYNC_STATE]: iso(-1 * DAY),
        [DEVICE_FULL_PASS_STATE]: iso(-2 * DAY), // more than a day ago
      },
      pages: [{ value: [unchanged] }],
    });

    await service.syncDevices(NOW);

    expect(inserted.map((r) => r['source'])).toEqual(['intune:same:unencrypted']);
  });

  it('does not duplicate a finding that already exists', async () => {
    const { service, inserted } = make({
      existingSources: new Set(['intune:a:unencrypted']),
      pages: [{ value: [device('a', { isEncrypted: false })] }],
    });

    const result = await service.syncDevices(NOW);

    expect(inserted).toEqual([]);
    expect(result.findings).toBe(0);
  });

  it('ONE DEVICE THAT CANNOT BE SAVED DOES NOT END THE PASS, and the cursor does not move past it', async () => {
    /*
     * `intune:<id>:noncompliant,unencrypted` overflowed the old varchar(60) source column (22001). Inside
     * the old shared transaction that aborted the whole pass; here the failing device is counted, the
     * rest are processed, and the cursor stays put so the failed device is tried again next pass.
     */
    const { service, inserted, saved } = make({
      failInsertFor: 'bad',
      pages: [
        {
          value: [device('bad', { isEncrypted: false }), device('good', { isEncrypted: false })],
        },
      ],
    });

    const result = await service.syncDevices(NOW);

    expect(result).toMatchObject({ devices: 2, findings: 1, errors: 1 });
    expect(inserted.map((r) => r['source'])).toEqual(['intune:good:unencrypted']);
    expect(saved).toEqual([]);
  });

  it('stores the newest lastSyncDateTime and the full-pass time after a clean pass', async () => {
    const newest = iso(-60_000);
    const { service, saved } = make({
      pages: [
        {
          value: [
            device('a', { lastSyncDateTime: iso(-3600_000) }),
            device('b', { lastSyncDateTime: newest }),
          ],
        },
      ],
    });

    await service.syncDevices(NOW);

    expect(saved).toEqual([
      { name: DEVICE_SYNC_STATE, cursor: newest },
      { name: DEVICE_FULL_PASS_STATE, cursor: NOW.toISOString() },
    ]);
  });

  it('truncates a name and version that would overflow their columns', async () => {
    const { service, inserted } = make({
      pages: [
        {
          value: [
            device('long', {
              isEncrypted: false,
              deviceName: 'n'.repeat(500),
              osVersion: 'v'.repeat(200),
            }),
          ],
        },
      ],
    });

    await service.syncDevices(NOW);

    expect((inserted[0]['softwareName'] as string).length).toBe(200);
    expect((inserted[0]['softwareVersion'] as string).length).toBe(60);
  });

  it('does nothing and calls nothing when Graph is off', async () => {
    const { service, graph, urls } = make({ pages: [] });
    graph.isEnabled.mockReturnValue(false);

    expect(await service.syncDevices(NOW)).toEqual({ devices: 0, findings: 0, errors: 0 });
    expect(urls).toHaveLength(0);
  });
});
