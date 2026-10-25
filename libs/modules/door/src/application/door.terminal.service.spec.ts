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
  listUnknownCardGroups: vi.fn(),
  listAllowList: vi.fn(),
  findCardCandidatesByUids: vi.fn(),
  insertEvents: vi.fn(),
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
    { getJson: vi.fn(), setJson: vi.fn() } as never, // cache
    { get: vi.fn(() => 5000) } as never, // config
    { schedule: vi.fn() } as never, // scheduler
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
    mockCards.findCardCandidatesByUids.mockResolvedValue([CARD]);
    mockCards.insertEvents.mockResolvedValue(1);
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
    mockCards.findCardCandidatesByUids.mockResolvedValue([
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
    mockCards.findCardCandidatesByUids.mockResolvedValue([
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

  it('counts the reported drops ONCE — only on the batch that inserted rows', async () => {
    mockCards.insertEvents.mockResolvedValue(1);
    await makeService().ingestEvents('term-1', {
      stream: STREAM,
      dropped: 12,
      events: [event({ seq: 1 })],
    });
    expect(mockTerminals.addDropped).toHaveBeenCalledWith('term-1', 12);

    // The resend inserts NOTHING (all conflicts) — its `dropped` must not count again (480/S3).
    vi.clearAllMocks();
    mockCards.findCardCandidatesByUids.mockResolvedValue([{ ...CARD }]);
    mockCards.insertEvents.mockResolvedValue(0);
    await makeService().ingestEvents('term-1', {
      stream: STREAM,
      dropped: 12,
      events: [event({ seq: 1 })],
    });
    expect(mockTerminals.addDropped).not.toHaveBeenCalled();
  });

  it('rejects UNSAFE seqs, non-Z dates and non-object events individually (480/S1, S2)', async () => {
    const r = await makeService().ingestEvents('term-1', {
      stream: STREAM,
      dropped: 0,
      events: [
        event({ seq: 1.5 }), // not a safe integer
        event({ seq: Number.MAX_SAFE_INTEGER + 1 }),
        event({ seq: 2, device_ts: '2026-10-23T08:01:02+03:00' }), // parsed, but not a Z stamp
        event({ seq: 3, device_ts: '2001-01-01T00:00:00Z' }), // outside the bounds
        null as never, // a null item is ONE rejected event, not a 422 for the batch
        'garbage' as never,
        {
          seq: 4,
          reader: 'in',
          uid: '04A1B2C3',
          result: 'allow',
          device_ts: new Date().toISOString(),
          time_synced: true,
        },
      ],
    });
    expect(r.ackedThrough).toBe(4); // safe-integer seqs only, always an integer
    expect(r.rejected).toEqual([1.5, Number.MAX_SAFE_INTEGER + 1, 2, 3]);
    expect(mockCards.insertEvents).toHaveBeenCalledWith('term-1', [
      expect.objectContaining({ seq: 4 }),
    ]);
  });

  it('credits a swipe that happened BEFORE a revocation (480/B1: candidates ignore status)', async () => {
    // Card valid from two hours ago, revoked (not expired) one hour ago; valid_until never moved.
    mockCards.findCardCandidatesByUids.mockResolvedValue([
      {
        id: CARD.id,
        uid: CARD.uid,
        validFrom: new Date(Date.now() - 2 * HOUR),
        validUntil: null,
        revokedAt: new Date(Date.now() - HOUR),
      },
    ]);
    // Synced swipe taken 90 minutes ago: inside the window (before the revocation).
    await makeService().ingestEvents('term-1', {
      stream: STREAM,
      dropped: 0,
      events: [
        event({
          seq: 10,
          device_ts: new Date(Date.now() - 90 * 60_000).toISOString(),
          time_synced: true,
        }),
      ],
    });
    const [credited] = mockCards.insertEvents.mock.calls[0][1] as { cardId: string | null }[];
    expect(credited.cardId).toBe(CARD.id);

    // A swipe NOW (after the revocation) resolves to nobody — buffered upload, wrong holder page.
    await makeService().ingestEvents('term-1', {
      stream: STREAM,
      dropped: 0,
      events: [event({ seq: 11, time_synced: true })],
    });
    const calls = mockCards.insertEvents.mock.calls;
    const [late] = calls[calls.length - 1][1] as { cardId: string | null }[];
    expect(late.cardId).toBeNull();
  });

  it('normalises the UID before candidate lookup', async () => {
    await makeService().ingestEvents('term-1', {
      stream: STREAM,
      dropped: 0,
      events: [event({ seq: 1, uid: '04:a1-b2c3' })],
    });
    expect(mockCards.findCardCandidatesByUids).toHaveBeenCalledWith(['04A1B2C3']);
  });
});
