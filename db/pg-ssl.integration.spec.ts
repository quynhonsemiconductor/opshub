/**
 * Proves the TLS decision against a REAL Postgres speaking TLS (CI: a self-signed CA with
 * SAN localhost; the job in backend-ci.yml generates the certificates). Skipped when
 * PG_TLS_URL is unset, so local unit runs are untouched.
 */
import { describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { pgOptions } from './pg-ssl';

const url = process.env.PG_TLS_URL;
const wrongCa = process.env.PG_TLS_WRONG_CA_BUNDLE === '1';
// A second server (PG_TLS_WRONG_HOST_URL) presents a certificate whose SAN has no IP
// entry, so connecting to 127.0.0.1 exercises the hostname check: right CA, wrong name.
const wrongHostUrl = process.env.PG_TLS_WRONG_HOST_URL;

describe('pgOptions against a TLS Postgres', () => {
  it.skipIf(!url || wrongCa)(
    'connects with verify-full: the right CA verifies chain and hostname',
    async () => {
      const caPath = process.env.PG_TLS_CA_FILE as string;
      const config = pgOptions(url as string, { caFile: caPath });
      expect(config.ssl).toMatchObject({ rejectUnauthorized: true });
      const client = new Client(config);
      await client.connect();
      const res = await client.query('select 1 as one');
      const rows = res.rows as Array<{ one: number }>;
      expect(rows[0].one).toBe(1);
      await client.end();
    },
  );

  it.skipIf(!url || !wrongCa)('a CA the server does not chain to is refused', async () => {
    // A second, VALID CA (PG_TLS_ROGUE_CA_FILE): the real failure mode of a swapped
    // or stale bundle, and the one verify-full exists to catch.
    const client = new Client(
      pgOptions(url as string, { caFile: process.env.PG_TLS_ROGUE_CA_FILE }),
    );
    await expect(client.connect()).rejects.toThrow();
  });

  it.skipIf(!wrongHostUrl)('a valid chain for the WRONG hostname is refused', async () => {
    const client = new Client(
      pgOptions(wrongHostUrl as string, { caFile: process.env.PG_TLS_CA_FILE }),
    );
    await expect(client.connect()).rejects.toThrow(/certificate|hostname|altname/i);
  });
});
