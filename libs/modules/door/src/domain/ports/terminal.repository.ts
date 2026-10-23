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
  setTokenHash(id: string, tokenHash: string, tx?: unknown): Promise<DoorTerminal | null>;
  revoke(id: string, revokedAt: Date, tx?: unknown): Promise<DoorTerminal | null>;
  list(): Promise<DoorTerminal[]>;
  countActive(): Promise<number>;
}
