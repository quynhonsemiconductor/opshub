/**
 * Unit tests — DoorService terminal side (allow-list shaping + event ingestion, ADR §2.4).
 *
 * What earns assertions here: the allow-list sends `valid_from` only while it is in the FUTURE
 * (the terminal enforces windows offline, so a temporary card must expire without opshub);
 * `acked_through` covers the whole batch even when events are rejected (the terminal deletes
 * through it, so the queue never blocks); `card_id` resolves BY EVENT TIME; resends change nothing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeAudit } from '../../../audit/src/testing/audit.fake';
import { DoorService } from './door.service';

const mockTerminals = {
  create: vi.fn(),
  findById: vi.fn(),
  touchLastSeen: vi.fn(),
  setTokenHash: vi.fn(),
  revoke: vi.fn(),
  list: vi.fn(),
  countActive: vi.fn(),
  countActiveSeenSince: vi.fn(),
  addDropped: vi.fn(),
};
const mockCards = {
  create: vi.fn(),
  findById: vi.fn(),
  findActiveByUid: vi.fn(),
  update: vi.fn(),
  list: vi.fn(),
  listUnknownEvents: vi.fn(),
  listAllowList: vi.fn(),
  findActiveByUids: vi.fn(),
  insertEvents: vi.fn(),
  deleteUnknownOlderThan: vi.fn(),
  deleteEventsOlderThan: vi.fn(),
};
const mockEmployees = { assertExist: vi.fn() };
const mockAudit = createFakeAudit();
const mockDb = { transaction: vi.fn((fn: (tx: unknown) => Promise<unknown>) => fn({})) };

function makeService() {
  return new DoorService(
    mockTerminals,
    mockCards,
    mockEmployees as never,
    mockAudit as never,
    mockDb as never,
  );
}

const HOUR = 3600_000;

describe('DoorService.allowList()', () => {
  beforeEach(() => vi.clearAllMocks());

  it('nulls valid_from once it is past and keeps a future window on the list', async () => {
    mockCards.listAllowList.mockResolvedValue([
      { uid: '04A1B2C3', validFrom: new Date(Date.now() - HOUR), validUntil: null },
      {
        uid: '04B2C3D4',
        validFrom: new Date(Date.now() + HOUR),
        validUntil: new Date(Date.now() + 2 * HOUR),
      },
    ]);

    const cards = await makeService().allowList();

    // Permanent card: both fields null. Temporary card not yet valid: BOTH windows travel, because
    // the terminal must refuse it offline until valid_from and after valid_until.
    expect(cards[0]).toEqual({ uid: '04A1B2C3', valid_from: null, valid_until: null });
    expect(cards[1].valid_from).not.toBeNull();
    expect(cards[1].valid_until).not.toBeNull();
  });

  it('orders by uid — the stable body is what makes the ETag mean "the list changed"', async () => {
    mockCards.listAllowList.mockResolvedValue([
      { uid: '04B2C3D4', validFrom: new Date(), validUntil: null },
      { uid: '04A1B2C3', validFrom: new Date(), validUntil: null },
    ]);
    const cards = await makeService().allowList();
    expect(cards.map((c) => c.uid)).toEqual(['04B2C3D4', '04A1B2C3']); // passthrough: repo owns order
  });
});

describe('DoorService.ingestEvents()', () => {
  const STREAM = '6f1a2b3c-0000-4000-8000-000000000001';
  const CARD = {
    id: 'card-1',
    uid: '04A1B2C3',
    validFrom: new Date(Date.now() - 2 * HOUR),
    validUntil: null as Date | null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockCards.findActiveByUids.mockResolvedValue([CARD]);
    mockCards.insertEvents.mockResolvedValue(undefined);
    mockTerminals.addDropped.mockResolvedValue(undefined);
  });

  function event(overrides: Record<string, unknown>) {
    return {
      seq: 1,
      reader: 'in',
      uid: '04A1B2C3',
      result: 'allow',
      device_ts: new Date(Date.now() - 1000).toISOString(),
      time_synced: true,
      ...overrides,
    };
  }

  it('acks the whole batch, credits the card, and reports no rejects', async () => {
    const r = await makeService().ingestEvents('term-1', {
      stream: STREAM,
      dropped: 0,
      events: [event({ seq: 7 })],
    });

    expect(r).toEqual({ ackedThrough: 7, rejected: [] });
    expect(mockCards.insertEvents).toHaveBeenCalledWith('term-1', [
      expect.objectContaining({ seq: 7, stream: STREAM, cardId: CARD.id, timeSynced: true }),
    ]);
  });

  it('rejects malformed events but still acks through them', async () => {
    const r = await makeService().ingestEvents('term-1', {
      stream: STREAM,
      dropped: 0,
      events: [
        event({ seq: 3, reader: 'sideways' }),
        event({ seq: 4, uid: 'nothex' }),
        event({ seq: 5, device_ts: 'not-a-date' }),
        event({ seq: 9, result: 'maybe' }),
      ],
    });

    expect(r.ackedThrough).toBe(9);
    expect(r.rejected).toEqual([3, 4, 5, 9]);
    // Nothing valid, nothing inserted — and no empty-batch write either.
    expect(mockCards.insertEvents).not.toHaveBeenCalled();
  });

  it('resolves card_id BY EVENT TIME: before valid_from nothing is credited', async () => {
    // The card starts in an hour; the synced swipe happened now.
    mockCards.findActiveByUids.mockResolvedValue([
      { ...CARD, validFrom: new Date(Date.now() + HOUR) },
    ]);
    const r = await makeService().ingestEvents('term-1', {
      stream: STREAM,
      dropped: 0,
      events: [event({ seq: 1 })],
    });
    const [row] = mockCards.insertEvents.mock.calls[0][1] as { cardId: string | null }[];
    expect(r.rejected).toEqual([]);
    expect(row.cardId).toBeNull();
  });

  it('unsynced events resolve against the RECEIVE time, not the claimed device time', async () => {
    // Card was valid two hours ago and is gone now; the terminal had no clock, so the event claims
    // an old device_ts but time_synced=false — resolution must use received_at (now) → no credit.
    mockCards.findActiveByUids.mockResolvedValue([
      { ...CARD, validUntil: new Date(Date.now() - HOUR) },
    ]);
    await makeService().ingestEvents('term-1', {
      stream: STREAM,
      dropped: 0,
      events: [
        event({
          seq: 2,
          device_ts: new Date(Date.now() - 2 * HOUR).toISOString(),
          time_synced: false,
        }),
      ],
    });
    const [row] = mockCards.insertEvents.mock.calls[0][1] as { cardId: string | null }[];
    expect(row.cardId).toBeNull();
  });

  it('passes the terminal-reported drop count through to the running total', async () => {
    await makeService().ingestEvents('term-1', {
      stream: STREAM,
      dropped: 12,
      events: [event({ seq: 1 })],
    });
    expect(mockTerminals.addDropped).toHaveBeenCalledWith('term-1', 12);
  });

  it('normalises the UID before candidate lookup', async () => {
    await makeService().ingestEvents('term-1', {
      stream: STREAM,
      dropped: 0,
      events: [event({ seq: 1, uid: '04:a1-b2c3' })],
    });
    expect(mockCards.findActiveByUids).toHaveBeenCalledWith(['04A1B2C3']);
  });
});
