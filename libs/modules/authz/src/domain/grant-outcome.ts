/** What a direct-permission grant did to the table, so the caller audits only what actually happened. */
export const GRANT_OUTCOME = {
  /** No row for this (permission, scope) existed; one was inserted. */
  CREATED: 'created',
  /** A row existed but had expired; it was given the new expiry, reason and grantor in place. */
  RENEWED: 'renewed',
  /** A live row already held this (permission, scope); nothing was written. */
  UNCHANGED: 'unchanged',
} as const;

export type GrantOutcome = (typeof GRANT_OUTCOME)[keyof typeof GRANT_OUTCOME];
