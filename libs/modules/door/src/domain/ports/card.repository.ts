import type { DoorCard, CreateCardInput, ListCardsFilters } from '../../domain/door.types';

export const CARD_REPOSITORY = Symbol('CARD_REPOSITORY');

/** One enrolled-later UID's view of the 24 h unknown list (ADR §2.5, SA review B6). */
export interface UnknownCardGroup {
  uid: string;
  /** The reader of the MOST RECENT unknown swipe on this UID. */
  reader: 'in' | 'out';
  /** How many times the readers saw it in the window. */
  count: number;
  /** When the readers last saw it. */
  lastSeenAt: Date;
}

export interface ICardRepository {
  create(input: CreateCardInput & { uid: string }, tx?: unknown): Promise<DoorCard>;
  findById(id: string): Promise<DoorCard | null>;
  /** The active card holding this UID, if any — the duplicate check before every insert. */
  findActiveByUid(uid: string): Promise<DoorCard | null>;
  update(
    id: string,
    input: Partial<Pick<DoorCard, 'label' | 'status' | 'validFrom' | 'validUntil' | 'revokedAt'>>,
    tx?: unknown,
  ): Promise<DoorCard | null>;
  list(
    filters: ListCardsFilters,
    limit: number,
    offset: number,
  ): Promise<{ rows: DoorCard[]; total: number }>;
  /**
   * Enrolment list, GROUPED PER UID: events with `card_id IS NULL` in the last 24 hours whose UID
   * does not hold an ACTIVE card NOW — once HR enrols a UID, it leaves the list even though the
   * pre-enrolment events stay unknown forever. Newest swipe first.
   */
  listUnknownCardGroups(since: Date, limit: number): Promise<UnknownCardGroup[]>;
}
