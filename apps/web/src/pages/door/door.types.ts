import type { components } from '@/shared/api/types';

/**
 * Door page types, THROUGH THE GENERATED CLIENT (see use-licenses.ts for why hand-written shapes
 * here are a second source of truth that has already drifted once).
 */
export type DoorTerminal = components['schemas']['DoorTerminalResponseDto'] & {
  /** Enriched by the terminals list from the battery cache (not part of the stored row). */
  battery?: { mv: number | null; low: boolean; reportedAt: string | null };
};
export type DoorCard = components['schemas']['DoorCardResponseDto'];
export type UnknownCardGroup = components['schemas']['UnknownCardGroupResponseDto'];

export const CARD_STATUS_FILTERS = ['active', 'revoked', 'lost'] as const;
