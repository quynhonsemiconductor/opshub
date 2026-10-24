/**
 * Unit tests — TerminalAuthGuard (SA review 480/S6).
 *
 * The guard IS the door's authentication, so the spec is the negative space: every malformed shape
 * answers 401 (never a 500), a revoked terminal is indistinguishable from an unknown one, the
 * digest comparison rejects a wrong secret, and `last_seen_at` is written at most once a minute.
 * Repository errors propagate (an outage is a 5xx, not a tidy 401).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { sha256Hex } from '../../application/door.service';
import { TerminalAuthGuard, type DoorTerminalRequest } from './terminal-auth.guard';

const TERMINAL = {
  id: '018f0000-0000-7000-8000-000000000001',
  name: 'Main door',
  location: null,
  tokenHash: sha256Hex('correct-secret'),
  revokedAt: null,
  lastSeenAt: null,
  droppedEvents: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function makeGuard(over: { findById?: ReturnType<typeof vi.fn> } = {}) {
  const terminals = {
    create: vi.fn(),
    findById: vi.fn(over.findById ?? (() => TERMINAL)),
    touchLastSeen: vi.fn().mockResolvedValue(undefined),
    setTokenHash: vi.fn(),
    revoke: vi.fn(),
    list: vi.fn(),
    countActive: vi.fn(),
    countActiveSeenSince: vi.fn(),
    addDropped: vi.fn(),
  };
  const logger = { info: vi.fn(), setContext: vi.fn() };
  const guard = new TerminalAuthGuard(terminals as never, logger as never);
  return { guard, terminals, logger };
}

function request(authorization?: string): DoorTerminalRequest {
  return { headers: authorization === undefined ? {} : { authorization } } as DoorTerminalRequest;
}

function context(req: DoorTerminalRequest): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => req }) } as never;
}

async function canActivate(authorization?: string, over?: Parameters<typeof makeGuard>[0]) {
  const g = makeGuard(over);
  const ok = await g.guard.canActivate(context(request(authorization)));
  return { ok, ...g };
}

describe('TerminalAuthGuard', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ['missing header', undefined],
    ['not bearer', 'Basic abc'],
    ['no dot', 'Bearer abcdef'],
    ['empty secret', 'Bearer 018f0000-0000-7000-8000-000000000001.'],
    ['empty id', 'Bearer .c2VjcmV0'],
    ['not a uuid', 'Bearer terminal.abc'],
    ['uuid-ish but wrong shape', 'Bearer 018F0000.abc'],
  ])('401s on %s without touching the repository', async (_name, authorization) => {
    const { guard, terminals } = makeGuard();
    await expect(guard.canActivate(context(request(authorization)))).rejects.toThrow(
      UnauthorizedException,
    );
    expect(terminals.findById).not.toHaveBeenCalled();
  });

  it('401s on an unknown terminal', async () => {
    await expect(
      canActivate(`Bearer 018f0000-0000-7000-8000-000000000009.${btoa('x')}`, {
        findById: vi.fn(() => null),
      }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('401s on a revoked terminal, indistinguishably from an unknown one', async () => {
    await expect(
      canActivate(`Bearer ${TERMINAL.id}.${btoa('correct-secret')}`, {
        findById: vi.fn(() => ({ ...TERMINAL, revokedAt: new Date() })),
      }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('401s on a wrong secret (constant-time compare still decides)', async () => {
    await expect(canActivate(`Bearer ${TERMINAL.id}.${btoa('wrong-secret')}`)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('accepts the right token, exposes the terminal on the request, and logs its own field', async () => {
    // The secret is the literal token tail — whatever bytes the admin once received.
    const { ok, terminals, logger } = await canActivate(`Bearer ${TERMINAL.id}.correct-secret`);
    expect(ok).toBe(true);
    expect(terminals.findById).toHaveBeenCalledWith(TERMINAL.id);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ terminal_id: TERMINAL.id }),
      expect.any(String),
    );
  });

  it('writes last_seen_at at most once a minute', async () => {
    const { guard, terminals } = makeGuard();
    const req = request(`Bearer ${TERMINAL.id}.correct-secret`);

    await guard.canActivate(context(req));
    await guard.canActivate(context(req));
    await guard.canActivate(context(req));
    expect(terminals.touchLastSeen).toHaveBeenCalledTimes(1);

    // A minute later, the next request re-proves it.
    const last = (guard as unknown as { lastSeenTouch: Map<string, number> }).lastSeenTouch.get(
      TERMINAL.id,
    )!;
    (guard as unknown as { lastSeenTouch: Map<string, number> }).lastSeenTouch.set(
      TERMINAL.id,
      last - 61_000,
    );
    await guard.canActivate(context(req));
    expect(terminals.touchLastSeen).toHaveBeenCalledTimes(2);
  });

  it('lets repository errors SURFACE (an outage is a 5xx, never a 401)', async () => {
    const boom = Promise.reject(new Error('connection refused'));
    void boom.catch(() => undefined);
    await expect(
      canActivate(`Bearer ${TERMINAL.id}.${btoa('x')}`, { findById: vi.fn(() => boom) }),
    ).rejects.toThrow('connection refused');
  });
});
