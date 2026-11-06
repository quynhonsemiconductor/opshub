import { describe, expect, it, vi } from 'vitest';
import type { DrizzleDB } from '@platform';
import { RETENTION_RULES, RetentionCleanupCron } from './retention-cleanup.cron';

/** Runs the exclusive job body without Valkey: this spec is about the delete loop. */
const exclusive = {
  run: (_name: string, _ttl: number, fn: () => Promise<void>) => fn(),
} as never;

function service(execute: ReturnType<typeof vi.fn>, dryRun = false) {
  const config = { get: () => dryRun } as never;
  const cron = new RetentionCleanupCron({ execute } as unknown as DrizzleDB, exclusive, config);
  const log = vi.fn();
  const logger = (cron as unknown as { logger: Record<string, unknown> }).logger;
  logger['log'] = log;
  logger['error'] = log;
  return { cron, log };
}

describe('RetentionCleanupCron', () => {
  it('purges every listed table in one batch when there is little to delete', async () => {
    const execute = vi.fn().mockResolvedValue({ rowCount: 0 });
    const { cron } = service(execute);
    await cron.purge();
    // 4 backfill statements + one batch per retention rule
    expect(execute).toHaveBeenCalledTimes(4 + RETENTION_RULES.length);
  });

  it('keeps batching while a table returns a FULL batch, then stops on the short one', async () => {
    const execute = vi
      .fn()
      // four backfill statements, nothing to stamp
      .mockResolvedValueOnce({ rowCount: 0 })
      .mockResolvedValueOnce({ rowCount: 0 })
      .mockResolvedValueOnce({ rowCount: 0 })
      .mockResolvedValueOnce({ rowCount: 0 })
      .mockResolvedValueOnce({ rowCount: 5_000 })
      .mockResolvedValueOnce({ rowCount: 3 })
      .mockResolvedValue({ rowCount: 0 });
    const { cron } = service(execute);
    await cron.purge();
    // 4 backfill + 2 for the first rule + 1 for each remaining rule
    expect(execute).toHaveBeenCalledTimes(4 + RETENTION_RULES.length + 1);
  });

  it('one failing table is logged and does not starve the rest', async () => {
    const execute = vi
      .fn()
      // the four backfill statements succeed; the FIRST retention rule fails
      .mockResolvedValueOnce({ rowCount: 0 })
      .mockResolvedValueOnce({ rowCount: 0 })
      .mockResolvedValueOnce({ rowCount: 0 })
      .mockResolvedValueOnce({ rowCount: 0 })
      .mockRejectedValueOnce(new Error('permission denied'))
      .mockResolvedValue({ rowCount: 0 });
    const { cron, log } = service(execute);
    await expect(cron.purge()).resolves.toBeUndefined();
    expect(execute).toHaveBeenCalledTimes(4 + RETENTION_RULES.length);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ table: RETENTION_RULES[0].table }),
      'Retention cleanup failed for a table',
    );
  });

  it('dry run COUNTS with the same predicate and deletes nothing', async () => {
    const execute = vi.fn().mockResolvedValue({ rowCount: 0, rows: [{ count: 7 }] });
    const { cron, log } = service(execute, true);
    await cron.purge();
    expect(execute).toHaveBeenCalledTimes(4 + RETENTION_RULES.length);
    const countCalls = execute.mock.calls.slice(4);
    for (const call of countCalls) {
      expect(JSON.stringify(call[0])).toContain('count(*)');
      expect(JSON.stringify(call[0])).not.toContain('DELETE');
    }
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ wouldDelete: 7, dryRun: true }),
      'Retention cleanup: dry run',
    );
  });

  it('backfills terminal_at from the terminal timestamp, never from creation', async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ rowCount: 5_000 }) // first table: a full batch
      .mockResolvedValueOnce({ rowCount: 2 }) // then a short one
      .mockResolvedValue({ rowCount: 0 });
    const { cron, log } = service(execute);
    await cron.purge();
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ backfilled: 5_002 }),
      'Retention cleanup: backfilled terminal_at',
    );
    const backfillSql = JSON.stringify(execute.mock.calls[0]?.[0]);
    expect(backfillSql).toContain('now()');
    expect(backfillSql).not.toContain('created_at');
    expect(backfillSql).not.toContain('scheduled_at');
  });

  it('the policy list states the caps, and does not touch business or audit tables', () => {
    const byName = Object.fromEntries(RETENTION_RULES.map((r) => [r.name, r]));
    expect(byName['sessions']?.policy).toBe('expired session + 7 days');
    expect(byName['in-app-notifications']?.policy).toBe('365 days');
    expect(byName['secure-score-snapshots']?.policy).toContain('90 days');
    const tables = RETENTION_RULES.map((r) => r.table);
    expect(tables).not.toContain('audit.audit_logs');
    expect(tables.some((t) => t.includes('requests'))).toBe(false);
  });
});
