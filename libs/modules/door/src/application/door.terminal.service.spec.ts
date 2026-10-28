/**
 * Unit tests — DoorService terminal side (allow-list shaping + event ingestion, ADR §2.4).
 *
 * What earns assertions here: the allow-list sends `valid_from` only while it is in the FUTURE,
 * as INTEGER EPOCH SECONDS (the firmware parser reads uint epoch or null — never ISO strings; the
 * terminal enforces windows offline, so a temporary card must expire without opshub);
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
/** Battery-state cache: getJson returns the PREVIOUS sync's { low } per test. */
const mockCache = {
  getJson: vi.fn<() => Promise<{ low: boolean } | null>>().mockResolvedValue(null),
  setJson: vi.fn().mockResolvedValue(undefined),
};
const mockConfig = { get: vi.fn(() => 5000) };
const mockAlerts = {
  doorManageHolders: vi
    .fn<(terminals?: unknown) => Promise<string[]>>()
    .mockResolvedValue(['hr-1']),
  send: vi
    .fn<(recipientId: string, type: string, vars: unknown, key: string) => Promise<void>>()
    .mockResolvedValue(undefined),
};

function makeService() {
  return new DoorService(
    mockTerminals,
    mockCards,
    mockEmployees as never,
    mockAudit as never,
    mockDb as never,
    mockCache as never, // cache (ctor order: db, cache, config, alerts)
    mockConfig as never,
    mockAlerts as never,
  );
}

/** Ingest one batch carrying only battery telemetry (no events) and hand back the service. */
async function syncBattery(input: { battery_mv?: number; low_battery?: boolean }) {
  const service = makeService();
  // STREAM lives inside the ingestEvents describe; a battery-only batch carries no events, so
  // any valid stream uuid works.
  await service.ingestEvents('term-1', {
    stream: '6f1a2b3c-0000-4000-8000-0000000000ff',
    dropped: 0,
    events: [],
    ...input,
  });
  return service;
}

const HOUR = 3600_000;

describe('DoorService.allowList()', () => {
  beforeEach(() => vi.clearAllMocks());

  it('nulls valid_from once it is past and keeps a future window on the list', async () => {
    const from = new Date(Date.now() + HOUR);
    const until = new Date(Date.now() + 2 * HOUR);
    mockCards.listAllowList.mockResolvedValue([
      { uid: '04A1B2C3', validFrom: new Date(Date.now() - HOUR), validUntil: null },
      { uid: '04B2C3D4', validFrom: from, validUntil: until },
    ]);

    const cards = await makeService().allowList();

    // Permanent card: both fields null. Temporary card not yet valid: BOTH windows travel, because
    // the terminal must refuse it offline until valid_from and after valid_until.
    expect(cards[0]).toEqual({ uid: '04A1B2C3', valid_from: null, valid_until: null });
    // Windows are INTEGER EPOCH SECONDS (bench E2E review item 3): the firmware parser reads uint
    // epoch or null; an ISO string makes its whole list malformed.
    expect(cards[1]).toEqual({
      uid: '04B2C3D4',
      valid_from: Math.floor(from.getTime() / 1000),
      valid_until: Math.floor(until.getTime() / 1000),
    });
    expect(Number.isInteger(cards[1].valid_from)).toBe(true);
  });

  it('keeps a 256-card body with worst-case UIDs under the firmware 24 KiB response cap', async () => {
    // Bench E2E review item 3: 256 windowed cards as ISO strings serialize to 28.7 KB — past the
    // terminal's 24 KiB (RESP_CAP) buffer. Epoch seconds must stay under it (measured 20.5 KB).
    // The response body is exactly JSON.stringify of this array's wrapper (the controller
    // serializes the service output).
    mockCards.listAllowList.mockResolvedValue(
      Array.from({ length: 256 }, (_, i) => ({
        uid: (i.toString(16).toUpperCase().padStart(20, '0') + 'A1B2C3D4E5').slice(0, 20),
        validFrom: new Date(Date.now() + HOUR),
        validUntil: new Date(Date.now() + 2 * HOUR),
      })),
    );
    const cards = await makeService().allowList();
    const body = JSON.stringify({ cards });
    expect(body.length).toBeLessThan(24 * 1024);
    // Every field the parser reads is an integer or null — no string anywhere it does not expect.
    for (const c of cards) {
      expect(c.valid_from === null || Number.isInteger(c.valid_from)).toBe(true);
      expect(c.valid_until === null || Number.isInteger(c.valid_until)).toBe(true);
    }
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

  it('ACCEPTS an unsynced uptime stamp (~1970) — rejecting it lost attendance (bench E2E item 4)', async () => {
    // Before the fix, device_ts below 2020 failed the synced range check, the event went to
    // `rejected` yet was still acked through — the firmware deleted real attendance forever.
    const r = await makeService().ingestEvents('term-1', {
      stream: STREAM,
      dropped: 0,
      events: [
        event({ seq: 20, device_ts: '1970-01-01T00:00:05Z', time_synced: false }),
        event({ seq: 21, device_ts: '1970-01-01T00:42:00Z', time_synced: false }),
      ],
    });
    expect(r).toEqual({ ackedThrough: 21, rejected: [] });
    const rows = mockCards.insertEvents.mock.calls[0][1] as {
      deviceTs: Date;
      timeSynced: boolean;
      cardId: string;
    }[];
    // Stored AS SENT (uptime stamp kept for the "unverified" report flag), card credited by
    // received_at — the card covers now, so both land on the holder.
    expect(rows.map((x) => x.timeSynced)).toEqual([false, false]);
    expect(rows[0].deviceTs.getTime()).toBe(5000);
    expect(rows.every((x) => x.cardId === CARD.id)).toBe(true);
  });

  it('still rejects an unsynced event whose device_ts is not a Z-stamped ISO shape', async () => {
    // Unsynced skips the RANGE check, never the SHAPE check — and the rejection is named AND
    // acked: the terminal deletes through acked_through, so a silent no-ack would jam its queue.
    const r = await makeService().ingestEvents('term-1', {
      stream: STREAM,
      dropped: 0,
      events: [
        event({ seq: 30, device_ts: 'not-a-date', time_synced: false }),
        event({ seq: 31, device_ts: 'uptime:42s', time_synced: false }),
      ],
    });
    expect(r).toEqual({ ackedThrough: 31, rejected: [30, 31] });
    expect(mockCards.insertEvents).not.toHaveBeenCalled();
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

  describe('battery low transition (SA review #493 item 8)', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      mockCache.getJson.mockResolvedValue(null);
      mockTerminals.findById.mockResolvedValue({ id: 'term-1', name: 'Main door' });
    });

    it('notifies on the TRANSITION into low (fresh cache)', async () => {
      await syncBattery({ battery_mv: 4900 });
      expect(mockAlerts.send).toHaveBeenCalledTimes(1);
      expect(mockAlerts.send).toHaveBeenCalledWith(
        'hr-1',
        'door.low_battery',
        { terminalName: 'Main door', batteryMv: 4900, thresholdMv: 5000 },
        expect.stringMatching(/^door\.low_battery:term-1:/),
        'term-1',
      );
    });

    it('does NOT repeat while the previous sync was already low', async () => {
      mockCache.getJson.mockResolvedValue({ low: true });
      await syncBattery({ battery_mv: 4800 });
      expect(mockAlerts.send).not.toHaveBeenCalled();
    });

    it('re-arms after a non-low sync: low again notifies again', async () => {
      await syncBattery({ battery_mv: 5500 }); // non-low: clears the state
      expect(mockAlerts.send).not.toHaveBeenCalled();
      mockCache.getJson.mockResolvedValue({ low: false }); // the non-low sync's write
      await syncBattery({ battery_mv: 4700 });
      expect(mockAlerts.send).toHaveBeenCalledTimes(1);
    });

    it('battery_mv === threshold is NOT low; threshold-1 IS low', async () => {
      await syncBattery({ battery_mv: 5000 });
      expect(mockCache.setJson).toHaveBeenCalledWith(
        expect.stringContaining(':battery'),
        expect.objectContaining({ low: false }),
        expect.any(Number),
      );
      expect(mockAlerts.send).not.toHaveBeenCalled();

      await syncBattery({ battery_mv: 4999 });
      expect(mockAlerts.send).toHaveBeenCalledTimes(1);
    });

    it('a failed send leaves the cache un-low so the next sync sends again (b)', async () => {
      mockAlerts.send.mockRejectedValueOnce(new Error('outbox down'));
      await expect(syncBattery({ battery_mv: 4900 })).resolves.toBeDefined();
      expect(mockCache.setJson).not.toHaveBeenCalledWith(
        expect.stringContaining(':battery'),
        expect.objectContaining({ low: true }),
        expect.any(Number),
      );

      // The previous state is still "not low" (the cache was never written), so the transition
      // fires again and the send is retried.
      mockCache.getJson.mockResolvedValue(null);
      await syncBattery({ battery_mv: 4900 });
      expect(mockAlerts.send).toHaveBeenCalledTimes(2);
      expect(mockCache.setJson).toHaveBeenCalledWith(
        expect.stringContaining(':battery'),
        expect.objectContaining({ low: true }),
        expect.any(Number),
      );
    });

    it('the device flag alone (no mv) is low and reports mv: null', async () => {
      await syncBattery({ low_battery: true });
      expect(mockCache.setJson).toHaveBeenCalledWith(
        expect.stringContaining(':battery'),
        expect.objectContaining({ mv: null, low: true }),
        expect.any(Number),
      );
      expect(mockAlerts.send).toHaveBeenCalledWith(
        'hr-1',
        'door.low_battery',
        { terminalName: 'Main door', batteryMv: null, thresholdMv: 5000 },
        expect.any(String),
        'term-1',
      );
    });
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
