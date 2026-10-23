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

/** The shape of one allow-list row: the terminal's whole world (ADR §2.4). */
export interface AllowListEntry {
  uid: string;
  validFrom: Date;
  validUntil: Date | null;
}

/** A card_id RESOLUTION CANDIDATE: any card ever seen with this UID, in any status. */
export type CardCandidate = AllowListEntry & { id: string; revokedAt: Date | null };

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

  /**
   * The terminal allow-list, COMPUTED AT REQUEST TIME (ADR §2.4): active cards of employees who can
   * still enter (active or on leave), whose window has not closed. Ordered by uid — the response is
   * a stable body whose hash is the ETag.
   */
  listAllowList(): Promise<AllowListEntry[]>;

  /**
   * Cards for the UIDs an event batch reports — the card_id resolution's candidate set. NO status
   * filter ON PURPOSE (SA review 480/B1): a swipe that happened BEFORE a revocation must still
   * resolve to the card, so revoked/lost rows are candidates and the WINDOW (§3) decides.
   */
  findCardCandidatesByUids(uids: string[]): Promise<CardCandidate[]>;

  /**
   * The batch upsert: `ON CONFLICT (terminal_id, stream, seq) DO NOTHING` — resends are free.
   * Returns how many rows it actually INSERTED, so `dropped` is counted once (SA review 480/S3).
   */
  insertEvents(
    terminalId: string,
    rows: {
      stream: string;
      seq: number;
      reader: 'in' | 'out';
      uid: string;
      result: 'allow' | 'deny';
      cardId: string | null;
      deviceTs: Date;
      timeSynced: boolean;
    }[],
    tx?: unknown,
  ): Promise<number>;
}
