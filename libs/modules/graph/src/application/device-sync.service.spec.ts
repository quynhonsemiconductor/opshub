/**
 * The Intune device sync no longer uses `managedDevices/delta` (not a documented method) or an
 * in-memory link. It lists with a `lastSyncDateTime` filter and keeps the high-water mark in
 * `graph_sync_state`, saved only when the whole pass finished.
 */
import { describe, expect, it, vi } from 'vitest';
import { DeviceSyncService } from './device-sync.service';

function make(opts: {
  cursor?: string | null;
  pages: Array<{ value: unknown[]; '@odata.nextLink'?: string }>;
  existing?: boolean;
}) {
  const urls: string[] = [];
  const pages = [...opts.pages];
  const api = vi.fn((url: string) => {
    urls.push(url);
    return { get: vi.fn().mockImplementation(() => Promise.resolve(pages.shift())) };
  });
  const graph = { isEnabled: vi.fn().mockReturnValue(true), client: () => ({ api }) };
  const inserted: unknown[] = [];
  const upserts: unknown[] = [];
  const db = {
    select: vi.fn(() => {
      const c = {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        // First select is the cursor lookup, the rest are finding dedupe lookups.
        limit: vi
          .fn()
          .mockImplementation(() =>
            Promise.resolve(
              opts.existing
                ? [{ id: 'f', cursor: opts.cursor ?? null }]
                : [{ cursor: opts.cursor ?? null }],
            ),
          ),
      };
      return c;
    }),
    insert: vi.fn(() => ({
      values: vi.fn((v: unknown) => {
        inserted.push(v);
        return {
          onConflictDoUpdate: vi.fn(() => {
            upserts.push(v);
            return Promise.resolve();
          }),
          then: undefined,
        } as never;
      }),
    })),
  };
  return {
    service: new DeviceSyncService(graph as never, db as never),
    urls,
    inserted,
    upserts,
    graph,
  };
}

const device = (id: string, sync: string, extra: Record<string, unknown> = {}) => ({
  id,
  deviceName: id,
  osVersion: '1',
  complianceState: 'compliant',
  isEncrypted: true,
  lastSyncDateTime: sync,
  ...extra,
});

describe('DeviceSyncService', () => {
  it('lists the first time without a filter, and stores the newest lastSyncDateTime', async () => {
    const { service, urls, upserts } = make({
      pages: [
        { value: [device('a', '2026-10-11T01:00:00Z'), device('b', '2026-10-11T03:00:00Z')] },
      ],
    });

    const result = await service.syncDevices();

    expect(urls[0]).toMatch(/^\/deviceManagement\/managedDevices\?\$top=100&\$select=/);
    expect(urls[0]).not.toMatch(/filter/);
    expect(urls[0]).not.toMatch(/delta/);
    expect(result.devices).toBe(2);
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toEqual({ name: 'intune-managed-devices', cursor: '2026-10-11T03:00:00Z' });
  });

  it('resumes from the stored cursor with a lastSyncDateTime filter', async () => {
    const { service, urls } = make({ cursor: '2026-10-11T03:00:00Z', pages: [{ value: [] }] });

    await service.syncDevices();

    expect(decodeURIComponent(urls[0])).toContain(
      '$filter=lastSyncDateTime ge 2026-10-11T03:00:00Z',
    );
  });

  it('follows nextLink and does not move the cursor when nothing newer arrived', async () => {
    const { service, urls, upserts } = make({
      cursor: '2026-10-11T03:00:00Z',
      pages: [{ value: [], '@odata.nextLink': '/next?x=1' }, { value: [] }],
    });

    await service.syncDevices();

    expect(urls).toHaveLength(2);
    expect(upserts).toHaveLength(0);
  });

  it('does nothing and calls nothing when Graph is off', async () => {
    const { service, graph, urls } = make({ pages: [] });
    graph.isEnabled.mockReturnValue(false);

    expect(await service.syncDevices()).toEqual({ devices: 0, findings: 0 });
    expect(urls).toHaveLength(0);
  });
});
