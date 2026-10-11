/**
 * identity's own conformance kit, run against THIS repository's environment.
 *
 * identity's README requires it of every consumer's CI: the kit builds an instance over the reference schema,
 * drives it in process through `auth.handler` and a local OIDC mock, and fails if any secure default or
 * decision of the package (cookie flags, session lifetimes, the tenant and guest checks, the rate limits, the
 * ban and revocation behaviour, ...) is no longer in force. It is how a Better Auth bump, or a change to the
 * Postgres or Valkey we run it against, announces itself. It does not touch opshub's data or code.
 *
 * What it needs is a FRESH, EMPTY database and a Valkey key prefix nobody else uses. Both come from the
 * services the e2e job already has: a throwaway database is created on the same server and dropped after, so
 * the kit never sees (or can truncate) the e2e database. It needs a role that may CREATE DATABASE, which is the
 * migration role (`DATABASE_MIGRATION_URL`); the restricted app role cannot.
 *
 * Prereqs: `docker compose -f docker-compose.dev.yml up -d`.
 */
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runIdentityConformance } from '@quynhonsemiconductor/identity/testing';
import { pgOptions } from '../../db/pg-ssl';

const adminUrl = process.env['DATABASE_MIGRATION_URL'] ?? process.env['DATABASE_URL'];
const valkeyUrl = process.env['VALKEY_URL'] ?? process.env['REDIS_URL'];

/** The database named in a URL replaced, so one server hosts the throwaway next to the real one. */
function withDatabase(url: string, name: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  return parsed.toString();
}

if (!adminUrl || !valkeyUrl) {
  describe('identity conformance', () => {
    it('needs DATABASE_URL (or DATABASE_MIGRATION_URL) and VALKEY_URL', () => {
      // Not skipped: a job that silently stops running the kit would read as green.
      expect.fail(
        'set DATABASE_URL (or DATABASE_MIGRATION_URL) and VALKEY_URL for the conformance kit',
      );
    });
  });
} else {
  const created: string[] = [];
  let admin: Pool;

  beforeAll(() => {
    admin = new Pool({ ...pgOptions(adminUrl), max: 1 });
  });

  afterAll(async () => {
    for (const name of created) {
      await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    }
    await admin.end();
  });

  runIdentityConformance(
    { describe, it, beforeAll, afterAll, expect },
    {
      database: async () => {
        const name = `identity_conformance_${randomUUID().replace(/-/g, '')}`;
        await admin.query(`CREATE DATABASE "${name}"`);
        created.push(name);
        const url = withDatabase(adminUrl, name);
        const pool = new Pool(pgOptions(url));
        return { pool, stop: () => pool.end() };
      },
      valkey: () => Promise.resolve({ url: valkeyUrl, keyPrefix: `${randomUUID()}:` }),
    },
  );
}
