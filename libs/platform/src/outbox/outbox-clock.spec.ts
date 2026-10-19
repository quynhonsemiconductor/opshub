/**
 * The two clock helpers every outbox statement uses, rendered to SQL. A host Date or a literal now() in their place would
 * fail here (the Time rule, .github#29).
 */
import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { dbDelay, DB_NOW, leaseDelay } from './abstract-outbox-relay';

const dialect = new PgDialect();

describe('outbox clock helpers, rendered', () => {
  it('a retry is due at the database now() plus the delay, bound as seconds', () => {
    expect(dialect.sqlToQuery(dbDelay(30_000))).toMatchObject({
      sql: 'now() + make_interval(secs => $1)',
      params: [30],
    });
  });

  it('a lease runs from the statement (statement_timestamp()), not the transaction start', () => {
    expect(dialect.sqlToQuery(leaseDelay(120_000))).toMatchObject({
      sql: 'statement_timestamp() + make_interval(secs => $1)',
      params: [120],
    });
  });

  it('the due check and the cutoff use the same database now()', () => {
    expect(dialect.sqlToQuery(DB_NOW)).toMatchObject({ sql: 'now()', params: [] });
  });
});
