import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual, createHash } from 'node:crypto';
import { PinoLogger } from 'nestjs-pino';
import type { FastifyRequest } from 'fastify';
import { ITerminalRepository, TERMINAL_REPOSITORY } from '../../domain/ports/terminal.repository';
import type { DoorTerminal } from '../../domain/door.types';

/** Re-prove a terminal at most once a minute; `last_seen_at` is minute-grade data. */
const LAST_SEEN_INTERVAL_MS = 60_000;

export interface DoorTerminalRequest extends FastifyRequest {
  /**
   * Set by this guard; the controller reads the TERMINAL id from here, never from the body.
   * Only { id, name }: the request object can surface in traces/logs, and the token hash is a
   * credential-derived value that belongs in neither (SA review #493 item 7).
   */
  doorTerminal?: Pick<DoorTerminal, 'id' | 'name'>;
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * Authenticates a door TERMINAL (an ESP32 controller), not a person — the machine principal of the
 * door contract (ADR ATTENDANCE-DEVICE §2.3).
 *
 * The token is `<terminal_id>.<secret>`; opshub stores sha256(secret) and nothing else. Parsing is
 * total: ANY malformed credential answers 401 here, never a parse error 500. The digest comparison
 * is constant-time. A terminal with `revoked_at` set is refused like an unknown one — revocation
 * must not be distinguishable from a typo, or revoking would leak which tokens exist.
 *
 * `last_seen_at` is written at most once a minute per terminal (an in-process throttle; the column
 * is minute-grade and the write is per request otherwise). The terminal id travels as its OWN log
 * field (`terminal_id`), deliberately NOT through `setRequestPrincipal`, whose `userId` means an
 * identity user everywhere else (idempotency keys, the access log, audit actors).
 */
@Injectable()
export class TerminalAuthGuard implements CanActivate {
  private readonly lastSeenTouch = new Map<string, number>();

  constructor(
    @Inject(TERMINAL_REPOSITORY) private readonly terminals: ITerminalRepository,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(TerminalAuthGuard.name);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<DoorTerminalRequest>();

    const header = request.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      throw new UnauthorizedException('UNAUTHORIZED', 'Terminal token required');
    }
    const token = header.slice('Bearer '.length);
    const dot = token.indexOf('.');
    if (dot <= 0 || dot === token.length - 1) {
      throw new UnauthorizedException('UNAUTHORIZED', 'Invalid terminal token');
    }
    const terminalId = token.slice(0, dot);
    const secret = token.slice(dot + 1);
    // Shape FIRST: a non-uuid id cannot name a terminal, so it is a 401 without a lookup — and a
    // uuid-looking id for a terminal that does not exist is indistinguishable from it.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(terminalId)) {
      throw new UnauthorizedException('UNAUTHORIZED', 'Invalid terminal token');
    }

    // NO swallowed repository errors (SA review 480/S4): a database outage must surface as a 5xx,
    // never as a tidy 401 that reads as "bad token" — the terminal would re-provision for nothing.
    const terminal = await this.terminals.findById(terminalId);
    if (!terminal || terminal.revokedAt) {
      throw new UnauthorizedException('UNAUTHORIZED', 'Invalid terminal token');
    }

    // Constant-time: compare the sha256 DIGESTS, never the base64url secrets.
    const presented = sha256(secret);
    const stored = Buffer.from(terminal.tokenHash, 'hex');
    if (presented.length !== stored.length || !timingSafeEqual(presented, stored)) {
      throw new UnauthorizedException('UNAUTHORIZED', 'Invalid terminal token');
    }

    const now = Date.now();
    const last = this.lastSeenTouch.get(terminal.id) ?? 0;
    if (now - last >= LAST_SEEN_INTERVAL_MS) {
      this.lastSeenTouch.set(terminal.id, now);
      // Fire-and-forget on purpose: a slow last_seen write must never sit in the unlock-sync
      // path — but a FAILURE is warned, not swallowed: a terminal whose last_seen_at never
      // advances would silently fall out of the healthcheck's seen-recently window.
      void this.terminals.touchLastSeen(terminal.id, new Date()).catch((err: unknown) => {
        this.logger.warn({ err, terminal_id: terminal.id }, 'last_seen_at update failed');
      });
    }

    request.doorTerminal = { id: terminal.id, name: terminal.name };
    this.logger.info({ terminal_id: terminal.id }, 'door terminal authenticated');
    return true;
  }
}
