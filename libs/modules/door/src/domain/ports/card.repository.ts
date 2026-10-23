import type {
  DoorCard,
  UnknownCardEvent,
  CreateCardInput,
  ListCardsFilters,
} from '../../domain/door.types';

export const CARD_REPOSITORY = Symbol('CARD_REPOSITORY');

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
   * Enrolment list: events with `card_id IS NULL` in the last 24 hours, newest first. The terminal
   * is where a card gets read the first time, so this page is the enrolment UI's source.
   */
  listUnknownEvents(since: Date, limit: number): Promise<UnknownCardEvent[]>;
}
