import type { doorCardStatusEnum } from '../../../../../db/schema';

export type DoorCardStatus = (typeof doorCardStatusEnum.enumValues)[number];

/**
 * The registered ESP32 controller. The bearer secret itself is NEVER stored — the service hands it
 * to the caller exactly once, at create/regenerate; only `tokenHash` (sha256 hex) persists.
 */
export interface DoorTerminal {
  id: string;
  name: string;
  location: string | null;
  tokenHash: string;
  revokedAt: Date | null;
  lastSeenAt: Date | null;
  droppedEvents: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface DoorCard {
  id: string;
  /** identity.employees.id — validated with assertExist, no cross-schema FK. */
  employeeId: string;
  /** Uppercase hex without separators, 8/14/20 chars (4/7/10-byte UIDs). */
  uid: string;
  label: string | null;
  status: DoorCardStatus;
  validFrom: Date;
  validUntil: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** An event the terminal uploaded whose UID matched no card active AT THE EVENT (ADR §3). */
export interface UnknownCardEvent {
  id: string;
  terminalId: string;
  uid: string;
  result: 'allow' | 'deny';
  deviceTs: Date;
  receivedAt: Date;
}

export interface CreateTerminalInput {
  name: string;
  location?: string | null;
}

export interface CreateCardInput {
  employeeId: string;
  /** Raw reader output — normalised to storage shape by the service. */
  uid: string;
  label?: string | null;
  validFrom?: Date;
  validUntil?: Date | null;
}

export interface UpdateCardInput {
  label?: string | null;
  /** Only `revoked` and `lost` are writable here; a card comes back by REISSUE, not un-revocation. */
  status?: Extract<DoorCardStatus, 'revoked' | 'lost'>;
  validFrom?: Date;
  validUntil?: Date | null;
}

export interface ListCardsFilters {
  status?: DoorCardStatus;
  employeeId?: string;
}
