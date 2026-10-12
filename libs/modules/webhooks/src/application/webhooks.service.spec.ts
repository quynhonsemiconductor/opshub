/**
 * WebhooksService unit tests — subscription CRUD and delivery management.
 *
 * All Drizzle calls are mocked. No database required.
 */
import { describe, it, expect, vi } from 'vitest';
import { WebhooksService } from './webhooks.service';
import { NotFoundException } from '@platform';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSubRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sub-1',
    url: 'https://example.com/hook',
    secret: 'my-secret-min-16-chars!!!',
    events: ['request.approved', 'request.rejected'],
    description: 'Test subscription',
    active: true,
    createdAt: new Date('2025-01-01T00:00:00Z'),
    updatedAt: new Date('2025-01-01T00:00:00Z'),
    ...overrides,
  };
}

function makeDeliveryRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'del-1',
    subscriptionId: 'sub-1',
    eventType: 'request.approved',
    payload: { requestId: 'req-1' },
    status: 'delivered',
    attempts: 1,
    nextAttemptAt: new Date('2025-01-01T00:01:00Z'),
    deliveredAt: new Date('2025-01-01T00:00:30Z'),
    lastError: null,
    createdAt: new Date('2025-01-01T00:00:00Z'),
    ...overrides,
  };
}

/** Build a fluent Drizzle mock chain ending with the provided resolved value. */
function makeChain(resolvedValue: unknown) {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  const methods = [
    'select',
    'insert',
    'update',
    'delete',
    'from',
    'where',
    'set',
    'values',
    'returning',
    'limit',
    'orderBy',
    'eq',
  ];
  for (const m of methods) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  chain['returning'].mockResolvedValue(resolvedValue);
  chain['limit'].mockResolvedValue(resolvedValue);
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  chain['where'].mockImplementation(() => {
    const p = Promise.resolve(resolvedValue);
    return Object.assign(p, chain);
  });
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  chain['from'].mockImplementation(() => {
    const p = Promise.resolve(resolvedValue);
    return Object.assign(p, chain);
  });
  return chain;
}

function buildService(
  opts: {
    selectRows?: unknown[];
    insertRow?: unknown;
    updateRow?: unknown;
  } = {},
) {
  const { selectRows = [], insertRow = makeSubRow(), updateRow = makeSubRow() } = opts;

  const selectChain = makeChain(selectRows);
  const insertChain = makeChain([insertRow]);
  const updateChain = makeChain([updateRow]);
  const deleteChain = { delete: vi.fn(), where: vi.fn().mockResolvedValue(undefined) };

  const db = {
    select: vi.fn().mockReturnValue(selectChain),
    insert: vi.fn().mockReturnValue(insertChain),
    update: vi.fn().mockReturnValue(updateChain),
    delete: vi.fn().mockReturnValue(deleteChain),
  };

  const service = new WebhooksService(db as never);
  return { service, db, selectChain, insertChain, updateChain, deleteChain };
}

// ═════════════════════════════════════════════════════════════════════════════
// create()
// ═════════════════════════════════════════════════════════════════════════════

describe('WebhooksService.create()', () => {
  it('inserts a new subscription and returns it without secret', async () => {
    const row = makeSubRow();
    const { service } = buildService({ insertRow: row });

    const result = await service.create({
      url: row.url,
      secret: 'my-secret-min-16-chars!!!',
      events: ['request.approved'],
    });

    expect(result.id).toBe('sub-1');
    expect(result.url).toBe(row.url);
    // secret must NOT be in the returned domain object
    expect(result).not.toHaveProperty('secret');
  });

  it('maps description to null when not provided', async () => {
    const row = makeSubRow({ description: null });
    const { service } = buildService({ insertRow: row });

    const result = await service.create({
      url: row.url,
      secret: 'my-secret-min-16-chars!!!',
      events: ['request.approved'],
    });

    expect(result.description).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// list()
// ═════════════════════════════════════════════════════════════════════════════

describe('WebhooksService.list()', () => {
  it('returns all subscriptions without secret fields', async () => {
    const rows = [makeSubRow({ id: 'sub-1' }), makeSubRow({ id: 'sub-2' })];
    const { service } = buildService({ selectRows: rows });

    const result = await service.list();

    expect(result).toHaveLength(2);
    expect(result[0]?.id).toBe('sub-1');
    expect(result[1]?.id).toBe('sub-2');
    for (const r of result) {
      expect(r).not.toHaveProperty('secret');
    }
  });

  it('returns empty array when no subscriptions exist', async () => {
    const { service } = buildService({ selectRows: [] });
    const result = await service.list();
    expect(result).toHaveLength(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// getById()
// ═════════════════════════════════════════════════════════════════════════════

describe('WebhooksService.getById()', () => {
  it('returns the subscription when found', async () => {
    const row = makeSubRow({ id: 'sub-42' });
    const { service } = buildService({ selectRows: [row] });

    const result = await service.getById('sub-42');
    expect(result.id).toBe('sub-42');
    expect(result).not.toHaveProperty('secret');
  });

  it('throws NotFoundException when subscription is not found', async () => {
    const { service } = buildService({ selectRows: [] });
    await expect(service.getById('nonexistent')).rejects.toThrow(NotFoundException);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// setActive()
// ═════════════════════════════════════════════════════════════════════════════

describe('WebhooksService.setActive()', () => {
  it('sets active=false and returns updated subscription', async () => {
    const row = makeSubRow({ active: false });
    const { service } = buildService({ updateRow: row });

    const result = await service.setActive('sub-1', false);
    expect(result.active).toBe(false);
  });

  it('throws NotFoundException when subscription does not exist', async () => {
    const { service, db, updateChain } = buildService();
    // returning() resolves to empty array (no row updated)
    updateChain['returning'].mockResolvedValue([]);
    db.update.mockReturnValue(updateChain);

    await expect(service.setActive('ghost-id', true)).rejects.toThrow(NotFoundException);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// delete()
// ═════════════════════════════════════════════════════════════════════════════

describe('WebhooksService.delete()', () => {
  it('calls delete with the correct id and resolves', async () => {
    const { service, db, deleteChain } = buildService();
    await service.delete('sub-1');
    expect(db.delete).toHaveBeenCalledOnce();
    expect(deleteChain.where).toHaveBeenCalledOnce();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// listDeliveries()
// ═════════════════════════════════════════════════════════════════════════════

describe('WebhooksService.listDeliveries()', () => {
  it('returns deliveries for the subscription', async () => {
    const rows = [makeDeliveryRow(), makeDeliveryRow({ id: 'del-2' })];
    const { service } = buildService({ selectRows: rows });

    const result = await service.listDeliveries('sub-1');
    expect(result).toHaveLength(2);
    expect(result[0]?.subscriptionId).toBe('sub-1');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// retryDelivery()
// ═════════════════════════════════════════════════════════════════════════════

describe('WebhooksService.retryDelivery()', () => {
  it('resets a failed delivery to pending and clears lastError', async () => {
    const row = makeDeliveryRow({ status: 'pending', lastError: null });
    const { service } = buildService({ updateRow: row });

    const result = await service.retryDelivery('del-1');
    expect(result.status).toBe('pending');
    expect(result.lastError).toBeNull();
  });

  it('throws NotFoundException when delivery does not exist', async () => {
    const { service, db, updateChain } = buildService();
    updateChain['returning'].mockResolvedValue([]);
    db.update.mockReturnValue(updateChain);

    await expect(service.retryDelivery('ghost-del')).rejects.toThrow(NotFoundException);
  });
});
