import { describe, expect, it, vi } from 'vitest';
import { desc } from 'drizzle-orm';
import { complianceFindings } from '../../../../../db/schema';
import { ShadowItDetectionService } from './shadow-it-detection.service';

/**
 * WHAT THIS PINS, and why a unit test rather than a flow.
 *
 * `listShadowItFindings` takes the newest N detections and nothing else, so the ORDER is not a
 * presentation detail — it decides which rows exist in the response at all. The endpoint used to sort
 * ascending, so with more findings than the limit it returned the OLDEST fifty: a detection screen
 * that could not show a detection. Its own docblock said "most-recent SAMPLE" and the screen printed
 * "most recent first", and neither was true.
 *
 * An end-to-end test cannot see this without seeding more than fifty findings — and nothing in the
 * product creates one, since both writers are background sync jobs. What is checkable, exactly, is the
 * ORDER BY the query was built with.
 */
describe('listShadowItFindings', () => {
  function makeDb() {
    const calls: unknown[][] = [];
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'from', 'where']) chain[m] = vi.fn(() => chain);
    chain['orderBy'] = vi.fn((...args: unknown[]) => {
      calls.push(args);
      return chain;
    });
    chain['limit'] = vi.fn(() => Promise.resolve([]));
    return { db: chain, orderByCalls: calls };
  }

  it('takes the NEWEST findings, not the oldest', async () => {
    const { db, orderByCalls } = makeDb();
    // (graph, db) — the graph client is untouched by this read path.
    const service = new ShadowItDetectionService({} as never, db as never);

    await service.listShadowItFindings(50);

    /*
     * Compared against the drizzle expression itself rather than a string: `desc(col)` builds a SQL
     * node, and asserting on its serialised form would pass for `desc` applied to the wrong column.
     */
    expect(orderByCalls).toHaveLength(1);
    expect(orderByCalls[0]).toEqual([
      desc(complianceFindings.detectedAt),
      desc(complianceFindings.id),
    ]);
  });
});
