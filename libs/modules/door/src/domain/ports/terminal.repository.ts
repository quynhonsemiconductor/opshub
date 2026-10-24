import type { DoorTerminal, CreateTerminalInput } from '../../domain/door.types';

export const TERMINAL_REPOSITORY = Symbol('TERMINAL_REPOSITORY');

export interface ITerminalRepository {
  create(
    input: CreateTerminalInput & { id: string; tokenHash: string },
    tx?: unknown,
  ): Promise<DoorTerminal>;
  findById(id: string): Promise<DoorTerminal | null>;
  /** Touches `last_seen_at`, at most once a minute per terminal (the guard decides). */
  touchLastSeen(id: string, at: Date): Promise<void>;
  /**
   * Stores a new token hash ONLY while the terminal is not revoked — the WHERE carries
   * `revoked_at IS NULL`, so a revoke racing the rotation wins and this returns null.
   */
  setTokenHash(id: string, tokenHash: string, tx?: unknown): Promise<DoorTerminal | null>;
  /** Stamps revoked_at ONLY on a not-yet-revoked terminal; null = already revoked (or gone). */
  revoke(id: string, revokedAt: Date, tx?: unknown): Promise<DoorTerminal | null>;
  list(): Promise<DoorTerminal[]>;
  countActive(): Promise<number>;
  /** Active terminals whose last_seen_at is at/after `since` — the Healthchecks job's whole question. */
  countActiveSeenSince(since: Date): Promise<number>;
  /** Adds a terminal-reported drop count to the running total. */
  addDropped(id: string, count: number, tx?: unknown): Promise<void>;
}
