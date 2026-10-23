import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import {
  ConflictException,
  ErrorCodes,
  InjectDrizzle,
  nameOf,
  NotFoundException,
  PreconditionFailedException,
  resolveEmployeeNames,
  ValidationException,
  type DrizzleDB,
} from '@platform';
import { newId, type Actor } from '@shared-kernel';
import {
  AuditService,
  AUDIT_ACTION,
  AUDIT_RESOURCE,
  type ResourceAuditTrail,
} from '@modules/audit';
import { EmployeeService } from '@modules/identity';
import { TERMINAL_REPOSITORY, type ITerminalRepository } from '../domain/ports/terminal.repository';
import {
  CARD_REPOSITORY,
  type ICardRepository,
  type UnknownCardGroup,
} from '../domain/ports/card.repository';
import type {
  DoorTerminal,
  DoorCard,
  CreateTerminalInput,
  CreateCardInput,
  UpdateCardInput,
  ListCardsFilters,
} from '../domain/door.types';

/** 256 bits: the practical floor for a bearer credential that must survive a flash read-out attempt. */
export const SECRET_BYTES = 32;

/**
 * A presented token is `<terminal_id>.<secret>`; opshub stores sha256(secret) and nothing else. The
 * constant-time comparison lives in TerminalAuthGuard (the terminal-routes PR); this is the secret's
 * BIRTH and replacement: bytes from the CSPRNG, shown to the admin exactly once, hashed, forgotten.
 */
export function generateToken(terminalId: string): { token: string; tokenHash: string } {
  const secret = randomBytes(SECRET_BYTES).toString('base64url');
  return { token: `${terminalId}.${secret}`, tokenHash: sha256Hex(secret) };
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * UID normalisation — the single choke point between what a reader reports and what we store.
 * Readers and people write `04:a1-b2c3`, `04 a1 b2 c3`, `04a1B2C3`; the CHECK constraint and the
 * partial unique index only ever see `04A1B2C3`.
 */
export function normaliseUid(raw: string): string {
  return raw.replace(/[\s:.-]/g, '').toUpperCase();
}

const UID_SHAPE = /^[0-9A-F]{8}([0-9A-F]{6}){0,2}$/;

/** One event as the TERMINAL sends it (snake_case wire names, validated per event). */
export interface IngestEvent {
  seq: number;
  reader: string;
  uid: unknown;
  result: string;
  device_ts: unknown;
  time_synced: unknown;
}

export function assertUid(uid: string): string {
  if (!UID_SHAPE.test(uid)) {
    throw new ValidationException(
      ErrorCodes.DOOR_CARD_UID_INVALID,
      `Card UID ${uid || '(empty)'} is not uppercase hex of a 4/7/10-byte UID`,
    );
  }
  return uid;
}

export function assertWindow(validFrom: Date, validUntil: Date | null | undefined): void {
  if (validUntil && validUntil <= validFrom) {
    throw new ValidationException(
      ErrorCodes.DOOR_CARD_WINDOW_INVALID,
      'Card validity window is empty: valid_until must be after valid_from',
    );
  }
}

/**
 * The admin side of the door: terminals (register, rotate token, revoke) and cards (enrol, label,
 * revoke, mark lost, temporary windows).
 *
 * AUDIT ENTRIES SHARE THE MUTATION'S TRANSACTION (audit-write ratchet): a token rotation or a card
 * revocation that commits with no trail row is exactly the event worth investigating later.
 */
@Injectable()
export class DoorService {
  private readonly terminalTrail: ResourceAuditTrail;
  private readonly cardTrail: ResourceAuditTrail;

  constructor(
    @Inject(TERMINAL_REPOSITORY) private readonly terminals: ITerminalRepository,
    @Inject(CARD_REPOSITORY) private readonly cards: ICardRepository,
    private readonly employees: EmployeeService,
    audit: AuditService,
    @InjectDrizzle() private readonly db: DrizzleDB,
  ) {
    this.terminalTrail = audit.forResource(AUDIT_RESOURCE.DOOR_TERMINAL);
    this.cardTrail = audit.forResource(AUDIT_RESOURCE.DOOR_CARD);
  }

  // ── Terminals ──────────────────────────────────────────────────────────────

  /**
   * The returned `token` is shown ONCE — it exists in this response and in no store anywhere.
   * The id is minted client-side (the repo would otherwise), so the token can embed it and the
   * guard can parse the id without a lookup.
   */
  async createTerminal(
    input: CreateTerminalInput,
    actor: Actor,
  ): Promise<{ terminal: DoorTerminal; token: string }> {
    const id = newId();
    const generated = generateToken(id);
    return this.db.transaction(async (tx) => {
      const terminal = await this.terminals.create(
        { id, ...input, tokenHash: generated.tokenHash },
        tx,
      );
      await this.terminalTrail.record(AUDIT_ACTION.DOOR_TERMINAL_CREATED, terminal.id, actor, tx, {
        after: { name: input.name, location: input.location ?? null },
      });
      return { terminal, token: generated.token };
    });
  }

  /** Rotates the secret. The old token stops working the moment this commits. */
  async regenerateTerminalToken(
    id: string,
    actor: Actor,
  ): Promise<{ terminal: DoorTerminal; token: string }> {
    const terminal = await this.getTerminal(id);
    if (terminal.revokedAt) {
      throw new PreconditionFailedException(
        ErrorCodes.DOOR_TERMINAL_REVOKED,
        'Terminal is revoked — provision a replacement instead of rotating its token',
      );
    }
    const generated = generateToken(id);
    return this.db.transaction(async (tx) => {
      const saved = await this.terminals.setTokenHash(id, generated.tokenHash, tx);
      if (!saved)
        throw new NotFoundException(ErrorCodes.DOOR_TERMINAL_NOT_FOUND, 'Terminal not found');
      // No secret material in the audit row: the trail records THAT a rotation happened, not what
      // the new credential is.
      await this.terminalTrail.record(
        AUDIT_ACTION.DOOR_TERMINAL_TOKEN_REGENERATED,
        id,
        actor,
        tx,
        {},
      );
      return { terminal: saved, token: generated.token };
    });
  }

  async revokeTerminal(id: string, actor: Actor): Promise<DoorTerminal> {
    const terminal = await this.getTerminal(id);
    if (terminal.revokedAt) return terminal; // revoke is idempotent; no second audit row
    return this.db.transaction(async (tx) => {
      const revoked = await this.terminals.revoke(id, new Date(), tx);
      if (!revoked)
        throw new NotFoundException(ErrorCodes.DOOR_TERMINAL_NOT_FOUND, 'Terminal not found');
      await this.terminalTrail.record(AUDIT_ACTION.DOOR_TERMINAL_REVOKED, id, actor, tx, {
        before: { revokedAt: null },
        after: { revokedAt: revoked.revokedAt },
      });
      return revoked;
    });
  }

  async getTerminal(id: string): Promise<DoorTerminal> {
    const terminal = await this.terminals.findById(id);
    if (!terminal)
      throw new NotFoundException(ErrorCodes.DOOR_TERMINAL_NOT_FOUND, 'Terminal not found');
    return terminal;
  }

  async listTerminals(): Promise<DoorTerminal[]> {
    return this.terminals.list();
  }

  // ── Cards ──────────────────────────────────────────────────────────────────

  async addCard(input: CreateCardInput, actor: Actor): Promise<DoorCard> {
    const uid = assertUid(normaliseUid(input.uid));
    await this.employees.assertExist(input.employeeId);
    // Offboarded people hold no door access by definition (the computed allow-list drops them);
    // enrolling a card for one is an HR mistake we can catch at the desk. on_leave stays allowed.
    const employee = await this.employees.getById(input.employeeId);
    if (employee.status === 'offboarded') {
      throw new ValidationException(
        ErrorCodes.DOOR_CARD_EMPLOYEE_OFFBOARDED,
        `${employee.displayName} is offboarded — cards can only be enrolled for active or on-leave employees`,
      );
    }
    const existing = await this.cards.findActiveByUid(uid);
    if (existing) {
      throw new ConflictException(
        ErrorCodes.DOOR_CARD_DUPLICATE,
        `An active card with UID ${uid} already exists — revoke it before reissuing`,
      );
    }
    assertWindow(input.validFrom ?? new Date(), input.validUntil);
    try {
      return await this.db.transaction(async (tx) => {
        const card = await this.cards.create({ ...input, uid }, tx);
        await this.cardTrail.record(AUDIT_ACTION.DOOR_CARD_CREATED, card.id, actor, tx, {
          after: { uid, employeeId: input.employeeId, label: input.label ?? null },
        });
        return card;
      });
    } catch (err) {
      // The service's pre-check narrows the window; the partial unique index still decides. A
      // concurrent enrol of the same UID is the conflict it looks like, not a 500.
      if (isUniqueViolation(err, 'uq_door_card_active_uid')) {
        throw new ConflictException(
          ErrorCodes.DOOR_CARD_DUPLICATE,
          `An active card with UID ${uid} already exists — revoke it before reissuing`,
        );
      }
      throw err;
    }
  }

  async updateCard(id: string, input: UpdateCardInput, actor: Actor): Promise<DoorCard> {
    const card = await this.getCard(id);
    if (
      card.revokedAt &&
      (input.status || input.validFrom !== undefined || input.validUntil !== undefined)
    ) {
      throw new ConflictException(
        ErrorCodes.DOOR_CARD_CLOSED,
        'Card is revoked or lost — reissue a new card instead of editing this one',
      );
    }
    const validFrom = input.validFrom ?? card.validFrom;
    const validUntil = 'validUntil' in input ? (input.validUntil ?? null) : card.validUntil;
    assertWindow(validFrom, validUntil);

    return this.db.transaction(async (tx) => {
      const patch: Parameters<ICardRepository['update']>[1] = {};
      if (input.label !== undefined) patch.label = input.label;
      if (input.validFrom !== undefined) patch.validFrom = input.validFrom;
      if (input.validUntil !== undefined) patch.validUntil = input.validUntil;
      if (input.status) {
        patch.status = input.status;
        // Both closing statuses stamp revoked_at (ADR §2.5); `lost` is a revoke with a reason.
        patch.revokedAt = new Date();
      }
      const updated = await this.cards.update(id, patch, tx);
      if (!updated) throw new NotFoundException(ErrorCodes.DOOR_CARD_NOT_FOUND, 'Card not found');
      const action =
        input.status === 'revoked'
          ? AUDIT_ACTION.DOOR_CARD_REVOKED
          : input.status === 'lost'
            ? AUDIT_ACTION.DOOR_CARD_MARKED_LOST
            : AUDIT_ACTION.DOOR_CARD_UPDATED;
      await this.cardTrail.record(action, id, actor, tx, {
        before: {
          label: card.label,
          status: card.status,
          validFrom: card.validFrom,
          validUntil: card.validUntil,
        },
        after: {
          label: updated.label,
          status: updated.status,
          validFrom: updated.validFrom,
          validUntil: updated.validUntil,
        },
      });
      return updated;
    });
  }

  async getCard(id: string): Promise<DoorCard> {
    const card = await this.cards.findById(id);
    if (!card) throw new NotFoundException(ErrorCodes.DOOR_CARD_NOT_FOUND, 'Card not found');
    return card;
  }

  async listCards(
    filters: ListCardsFilters,
    limit: number,
    offset: number,
  ): Promise<{ rows: (DoorCard & { employeeName: string | null })[]; total: number }> {
    const { rows, total } = await this.cards.list(filters, limit, offset);
    // Resolved with the raw executor (not a tx): a name is a READ join the record must survive —
    // resolveEmployeeNames returns no name rather than dropping the row when the person is gone.
    const names = await resolveEmployeeNames(
      this.db,
      rows.map((r) => r.employeeId),
    );
    return {
      rows: rows.map((r) => ({ ...r, employeeName: nameOf(names, r.employeeId) })),
      total,
    };
  }

  /**
   * Enrolment list: UIDs the readers saw in the last 24 h that belonged to nobody at the time
   * (ADR §2.5), grouped per UID, dropping UIDs that have since been enrolled — those are done.
   */
  async unknownCards(limit = 200): Promise<UnknownCardGroup[]> {
    const since = new Date(Date.now() - 24 * 3600 * 1000);
    return this.cards.listUnknownCardGroups(since, limit);
  }

  // ── Terminal side (the ESP32; the routes live in the terminal controller) ──

  /**
   * The allow-list, COMPUTED AT REQUEST TIME (ADR §2.4). The response shape is the contract:
   * `valid_from` is sent only while it is in the future (else null) — the terminal enforces the
   * window offline, so a temporary card expires even when opshub is unreachable.
   */
  async allowList(): Promise<
    { uid: string; valid_from: string | null; valid_until: string | null }[]
  > {
    const rows = await this.cards.listAllowList();
    const now = Date.now();
    // WIRE NAMES: the contract is snake_case (ADR §2.4) — the firmware never sees camelCase.
    return rows.map((r) => ({
      uid: r.uid,
      valid_from: r.validFrom.getTime() > now ? r.validFrom.toISOString() : null,
      valid_until: r.validUntil ? r.validUntil.toISOString() : null,
    }));
  }

  /**
   * Ingest one event batch (ADR §2.4). Per-event validation — a batch of 100 with one bad event
   * acks 99 of them; the bad seq goes into `rejected` and the terminal deletes through it, so one
   * malformed row can never block the queue. `card_id` is resolved BY EVENT TIME: the card whose
   * uid matches and whose window covered the swipe, so a buffered event uploaded after a UID was
   * reissued is credited to the person who held the card when they swiped.
   *
   * NOT wrapped in one transaction on purpose: the upsert is idempotent (`ON CONFLICT DO NOTHING`
   * on the event key), so a partial application retried by the terminal is harmless — and a
   * terminal should not wait on a long lock because a stranger's batch shares its poll cycle.
   */
  async ingestEvents(
    terminalId: string,
    input: { stream: string; dropped: number; events: IngestEvent[] },
  ): Promise<{ ackedThrough: number; rejected: number[] }> {
    const now = new Date();
    const rejected: number[] = [];
    const valid: NonNullable<Parameters<ICardRepository['insertEvents']>[1]> = [];
    let ackedThrough = 0;

    for (const event of input.events) {
      // The ack covers everything the batch carried, valid or not (ADR §2.4: the terminal deletes
      // through `acked_through`, so the queue never blocks).
      if (event.seq > ackedThrough) ackedThrough = event.seq;

      const uid = normaliseUid(typeof event.uid === 'string' ? event.uid : '');
      const deviceTs = parseIso(event.device_ts);
      if (
        !Number.isInteger(event.seq) ||
        event.seq <= 0 ||
        (event.reader !== 'in' && event.reader !== 'out') ||
        !UID_SHAPE.test(uid) ||
        (event.result !== 'allow' && event.result !== 'deny') ||
        !deviceTs
      ) {
        rejected.push(event.seq);
        continue;
      }
      valid.push({
        stream: input.stream,
        seq: event.seq,
        reader: event.reader,
        uid,
        result: event.result,
        cardId: null, // resolved below, by event time
        deviceTs,
        timeSynced: event.time_synced === true,
      });
    }

    // Resolve card_id for every valid event: one candidate query for the whole batch, then a
    // window match per event at t = device_ts (synced) or received_at (not).
    if (valid.length > 0) {
      const candidates = await this.cards.findActiveByUids([...new Set(valid.map((v) => v.uid))]);
      for (const row of valid) {
        const t = row.timeSynced ? row.deviceTs.getTime() : now.getTime();
        const match = candidates.find(
          (c) => c.uid === row.uid && c.validFrom.getTime() <= t && t < cardEnd(c),
        );
        if (match) row.cardId = match.id;
      }
      await this.cards.insertEvents(terminalId, valid);
    }

    await this.terminals.addDropped(terminalId, input.dropped);
    return { ackedThrough, rejected };
  }
}

/** `coalesce(revoked_at, valid_until, 'infinity')` — the open end of a card's validity, in JS. */
function cardEnd(card: { validUntil: Date | null }): number {
  return card.validUntil ? card.validUntil.getTime() : Number.POSITIVE_INFINITY;
}

function parseIso(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** True when `err` is Postgres 23505 on the named constraint (Drizzle surfaces both fields). */
function isUniqueViolation(err: unknown, constraint: string): boolean {
  const e = err as { code?: string; constraint?: string };
  return e?.code === '23505' && e?.constraint === constraint;
}
