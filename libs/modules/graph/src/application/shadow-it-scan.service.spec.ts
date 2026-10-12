import { describe, expect, it, vi } from 'vitest';
import { MAX_SCAN_PAGES } from '../graph-task';
import { ShadowItScanService } from './shadow-it-scan.service';

/** Every bound string parameter in a drizzle condition, depth first. */
function paramsOf(cond: unknown): string[] {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const chunks = (node as { queryChunks?: unknown[] }).queryChunks;
    if (chunks) chunks.forEach(walk);
    const value = (node as { value?: unknown }).value;
    if (typeof value === 'string') out.push(value);
  };
  walk(cond);
  return out;
}

function make(pages: Array<{ value: unknown[]; '@odata.nextLink'?: string }>) {
  const queue = [...pages];
  const api = vi.fn(() => ({ get: () => Promise.resolve(queue.shift()) }));
  const graph = { isEnabled: () => true, client: () => ({ api }) };
  const dedupeConditions: unknown[] = [];
  const inserted: unknown[] = [];
  const db = {
    select: vi.fn((cols?: Record<string, unknown>) => ({
      from: vi.fn(() =>
        cols && 'name' in cols
          ? Promise.resolve([]) // the software catalog
          : {
              where: vi.fn((cond: unknown) => {
                dedupeConditions.push(cond);
                return { limit: vi.fn().mockResolvedValue([]) };
              }),
            },
      ),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((v: unknown) => {
        inserted.push(v);
        return Promise.resolve();
      }),
    })),
  };
  return {
    service: new ShadowItScanService(graph as never, db as never),
    api,
    dedupeConditions,
    inserted,
  };
}

const app = (id: string) => ({ id, displayName: `app-${id}`, version: '1', deviceCount: 1 });

describe('ShadowItScanService', () => {
  it('dedupes against live findings but NOT a resolved one, so a recurrence is raised again', async () => {
    const { service, dedupeConditions, inserted } = make([{ value: [app('a')] }]);

    await service.detectShadowIt();

    const params = paramsOf(dedupeConditions[0]);
    expect(params).toContain('shadow-it:a');
    expect(params).toContain('resolved');
    expect(params).not.toContain('open');
    expect(inserted).toHaveLength(1);
  });

  it("stops at MAX_SCAN_PAGES: the scan's lease is sized for that many calls", async () => {
    const pages = Array.from({ length: MAX_SCAN_PAGES + 20 }, (_, i) => ({
      value: [],
      '@odata.nextLink': `/next?page=${i + 1}`,
    }));
    const { service, api } = make(pages);

    await service.detectShadowIt();

    expect(api).toHaveBeenCalledTimes(MAX_SCAN_PAGES);
  });
});
