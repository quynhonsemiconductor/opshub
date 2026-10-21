import { describe, expect, it, vi } from 'vitest';
import { ComplianceDrizzleRepository } from './compliance.drizzle-repository';

/**
 * A finding's detectedAt is stamped by the DATABASE (the Time rule): the repository must not put the application
 * host's clock into the insert. The insert is captured, so this reads what would be written, not what is returned.
 */
function makeDb() {
  const chain = {
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([{ id: 'f-1' }]),
  };
  return { insert: vi.fn().mockReturnValue(chain), chain };
}

const base = { softwareName: 'Acme', severity: 'high', source: 'device-sync' };

describe('ComplianceDrizzleRepository.createFinding', () => {
  it('leaves detectedAt to the database default when the caller has no timestamp to keep', async () => {
    const db = makeDb();
    await new ComplianceDrizzleRepository(db as never).createFinding(base as never);

    const written = db.chain.values.mock.calls[0][0] as { detectedAt?: Date };
    expect(written.detectedAt).toBeUndefined();
  });

  it('keeps a timestamp the caller supplies', async () => {
    const db = makeDb();
    const at = new Date('2026-01-02T03:04:05Z');
    await new ComplianceDrizzleRepository(db as never).createFinding({
      ...base,
      detectedAt: at,
    } as never);

    const written = db.chain.values.mock.calls[0][0] as { detectedAt?: Date };
    expect(written.detectedAt).toBe(at);
  });
});
