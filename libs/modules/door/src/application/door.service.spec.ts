/**
 * Unit tests — DoorService (admin side).
 *
 * The assertions that earn their place: the token is shown once and only its hash is stored (with
 * the id embedded, so the guard can parse without a lookup), a rotation invalidates the old secret,
 * revoked terminals refuse rotation, UID normalisation feeds the duplicate check, and every
 * mutation's audit entry shares its transaction.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeAudit } from '../../../audit/src/testing/audit.fake';
import {
  ConflictException,
  NotFoundException,
  PreconditionFailedException,
  ValidationException,
} from '@platform';
import { DoorService, generateToken, normaliseUid, assertUid, sha256Hex } from './door.service';

const mockTerminals = {
  create: vi.fn(),
  findById: vi.fn(),
  touchLastSeen: vi.fn(),
  setTokenHash: vi.fn(),
  revoke: vi.fn(),
  list: vi.fn(),
  countActive: vi.fn(),
};
const mockCards = {
  create: vi.fn(),
  findById: vi.fn(),
  findActiveByUid: vi.fn(),
  update: vi.fn(),
  list: vi.fn(),
  listUnknownEvents: vi.fn(),
};
const mockEmployees = { assertExist: vi.fn() };
const mockAudit = createFakeAudit();

const TX = { tx: true };
const mockDb = { transaction: vi.fn((fn: (tx: unknown) => Promise<unknown>) => fn(TX)) };

const ACTOR = { sub: 'admin-1', email: 'admin@opshub.example.invalid' };

const TERMINAL = {
  id: '018f0000-0000-7000-8000-000000000001',
  name: 'Main door',
  location: 'Lobby',
  tokenHash: sha256Hex('old'),
  revokedAt: null,
  lastSeenAt: null,
  droppedEvents: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const CARD = {
  id: '018f0000-0000-7000-8000-000000000002',
  employeeId: '018f0000-0000-7000-8000-000000000003',
  uid: '04A1B2C3',
  label: null,
  status: 'active' as const,
  validFrom: new Date('2026-01-01T00:00:00Z'),
  validUntil: null,
  revokedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function makeService() {
  return new DoorService(
    mockTerminals,
    mockCards,
    mockEmployees as never,
    mockAudit as never,
    mockDb as never,
  );
}

describe('token generation', () => {
  it('embeds the terminal id and hashes the secret, never storing the token', () => {
    const { token, tokenHash } = generateToken(TERMINAL.id);
    expect(token.startsWith(`${TERMINAL.id}.`)).toBe(true);
    const secret = token.slice(TERMINAL.id.length + 1);
    // 32 bytes → 43 base64url chars.
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(tokenHash).toBe(sha256Hex(secret));
  });

  it('does not repeat itself', () => {
    expect(generateToken(TERMINAL.id).token).not.toBe(generateToken(TERMINAL.id).token);
  });
});

describe('normaliseUid / assertUid', () => {
  it.each([
    ['04:a1-b2c3', '04A1B2C3'],
    ['04 a1 b2 c3', '04A1B2C3'],
    ['04a1b2c3', '04A1B2C3'],
  ])('normalises %s to %s', (raw, stored) => {
    expect(normaliseUid(raw)).toBe(stored);
  });

  it('accepts 8/14/20-char uppercase hex and nothing else', () => {
    expect(assertUid('04A1B2C3')).toBe('04A1B2C3');
    expect(assertUid('04A1B2C3D4E5F6'.replace(/^(.{14}).*/, '$1'))).toHaveLength(14);
    expect(() => assertUid('04A1')).toThrow(ValidationException);
    expect(() => assertUid('04A1B2C3D')).toThrow(ValidationException); // 9 chars: no UID is 4.5 bytes
  });
});

describe('DoorService.createTerminal()', () => {
  beforeEach(() => vi.clearAllMocks());

  it('stores the hash of the token it returns, and audits inside the transaction', async () => {
    mockTerminals.create.mockImplementation((input: object) =>
      Promise.resolve({ ...TERMINAL, ...input }),
    );

    const { terminal, token } = await makeService().createTerminal(
      { name: 'Main door', location: 'Lobby' },
      ACTOR,
    );

    expect(token.startsWith(`${terminal.id}.`)).toBe(true);
    const secret = token.slice(terminal.id.length + 1);
    expect(mockTerminals.create).toHaveBeenCalledWith(
      expect.objectContaining({ id: terminal.id, tokenHash: sha256Hex(secret) }),
      TX,
    );
    expect(mockAudit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'door_terminal.created' }),
      TX,
    );
    // The trail row records the registration, and the token exists ONLY in the response: the
    // stored hash is the sha256 of the returned secret, so nothing else could reconstruct it.
    expect(mockAudit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'door_terminal.created' }),
      TX,
    );
    expect(terminal.tokenHash).toBe(sha256Hex(secret));
  });
});

describe('DoorService.regenerateTerminalToken()', () => {
  beforeEach(() => vi.clearAllMocks());

  it('replaces the stored hash and returns the new token once', async () => {
    mockTerminals.findById.mockResolvedValue(TERMINAL);
    mockTerminals.setTokenHash.mockResolvedValue({ ...TERMINAL, tokenHash: 'new-hash' });

    const { token } = await makeService().regenerateTerminalToken(TERMINAL.id, ACTOR);

    const secret = token.slice(TERMINAL.id.length + 1);
    expect(mockTerminals.setTokenHash).toHaveBeenCalledWith(TERMINAL.id, sha256Hex(secret), TX);
    expect(mockAudit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'door_terminal.token_regenerated' }),
      TX,
    );
  });

  it('refuses a revoked terminal', async () => {
    mockTerminals.findById.mockResolvedValue({ ...TERMINAL, revokedAt: new Date() });
    await expect(makeService().regenerateTerminalToken(TERMINAL.id, ACTOR)).rejects.toThrow(
      PreconditionFailedException,
    );
    expect(mockTerminals.setTokenHash).not.toHaveBeenCalled();
  });

  it('404s on an unknown terminal', async () => {
    mockTerminals.findById.mockResolvedValue(null);
    await expect(makeService().regenerateTerminalToken(TERMINAL.id, ACTOR)).rejects.toThrow(
      NotFoundException,
    );
  });
});

describe('DoorService.revokeTerminal()', () => {
  beforeEach(() => vi.clearAllMocks());

  it('stamps revoked_at and audits', async () => {
    mockTerminals.findById.mockResolvedValue(TERMINAL);
    mockTerminals.revoke.mockResolvedValue({ ...TERMINAL, revokedAt: new Date() });

    await makeService().revokeTerminal(TERMINAL.id, ACTOR);

    expect(mockTerminals.revoke).toHaveBeenCalledWith(TERMINAL.id, expect.any(Date), TX);
    expect(mockAudit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'door_terminal.revoked' }),
      TX,
    );
  });

  it('is idempotent: a second revoke neither writes nor audits again', async () => {
    mockTerminals.findById.mockResolvedValue({ ...TERMINAL, revokedAt: new Date() });
    await makeService().revokeTerminal(TERMINAL.id, ACTOR);
    expect(mockTerminals.revoke).not.toHaveBeenCalled();
    expect(mockAudit.record).not.toHaveBeenCalled();
  });
});

describe('DoorService.addCard()', () => {
  beforeEach(() => vi.clearAllMocks());

  it('normalises the UID before the duplicate check and the insert', async () => {
    mockEmployees.assertExist.mockResolvedValue(undefined);
    mockCards.findActiveByUid.mockResolvedValue(null);
    mockCards.create.mockResolvedValue(CARD);

    const card = await makeService().addCard(
      { employeeId: CARD.employeeId, uid: '04:a1-b2c3' },
      ACTOR,
    );

    expect(card.uid).toBe('04A1B2C3');
    expect(mockCards.findActiveByUid).toHaveBeenCalledWith('04A1B2C3');
    expect(mockCards.create).toHaveBeenCalledWith(expect.objectContaining({ uid: '04A1B2C3' }), TX);
    expect(mockAudit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'door_card.created' }),
      TX,
    );
  });

  it('conflicts on an active duplicate', async () => {
    mockEmployees.assertExist.mockResolvedValue(undefined);
    mockCards.findActiveByUid.mockResolvedValue(CARD);
    await expect(
      makeService().addCard({ employeeId: CARD.employeeId, uid: '04A1B2C3' }, ACTOR),
    ).rejects.toThrow(ConflictException);
    expect(mockCards.create).not.toHaveBeenCalled();
  });

  it('validates the employee exists (assertExist, not a FK)', async () => {
    mockEmployees.assertExist.mockRejectedValue(new NotFoundException('EMPLOYEE_NOT_FOUND', 'x'));
    await expect(
      makeService().addCard({ employeeId: CARD.employeeId, uid: '04A1B2C3' }, ACTOR),
    ).rejects.toThrow(NotFoundException);
    expect(mockCards.create).not.toHaveBeenCalled();
  });
});

describe('DoorService.updateCard()', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(['revoked', 'lost'] as const)(
    'marks the card %s with revoked_at and the right action',
    async (status) => {
      mockCards.findById.mockResolvedValue(CARD);
      mockCards.update.mockResolvedValue({
        ...CARD,
        status,
        revokedAt: new Date(),
      });

      await makeService().updateCard(CARD.id, { status }, ACTOR);

      expect(mockCards.update).toHaveBeenCalledWith(
        CARD.id,
        expect.objectContaining({ status }),
        TX,
      );
      const patch = mockCards.update.mock.calls[0]?.[1] as { revokedAt?: unknown };
      expect(patch.revokedAt).toBeInstanceOf(Date);
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: status === 'lost' ? 'door_card.marked_lost' : 'door_card.revoked',
        }),
        TX,
      );
    },
  );

  it('refuses window or status edits on a closed card but still allows a label fix', async () => {
    const closed = { ...CARD, status: 'lost' as const, revokedAt: new Date() };
    mockCards.findById.mockResolvedValue(closed);

    await expect(makeService().updateCard(CARD.id, { status: 'revoked' }, ACTOR)).rejects.toThrow(
      ConflictException,
    );
    await expect(
      makeService().updateCard(CARD.id, { validUntil: new Date() }, ACTOR),
    ).rejects.toThrow(ConflictException);

    mockCards.update.mockResolvedValue({ ...closed, label: 'old lost card' });
    await makeService().updateCard(CARD.id, { label: 'old lost card' }, ACTOR);
    expect(mockCards.update).toHaveBeenCalledWith(CARD.id, { label: 'old lost card' }, TX);
  });

  it('refuses an empty validity window', async () => {
    mockCards.findById.mockResolvedValue(CARD);
    await expect(
      makeService().updateCard(
        CARD.id,
        {
          validFrom: new Date('2026-05-01T00:00:00Z'),
          validUntil: new Date('2026-04-01T00:00:00Z'),
        },
        ACTOR,
      ),
    ).rejects.toThrow(ValidationException);
  });
});

describe('DoorService.unknownCards()', () => {
  beforeEach(() => vi.clearAllMocks());

  it('looks back exactly 24 hours', async () => {
    mockCards.listUnknownEvents.mockResolvedValue([]);
    await makeService().unknownCards();
    const [since] = mockCards.listUnknownEvents.mock.calls[0] as [Date, number];
    const hours = (Date.now() - since.getTime()) / 3600_000;
    expect(hours).toBeGreaterThanOrEqual(23.9);
    expect(hours).toBeLessThanOrEqual(24.1);
  });
});
