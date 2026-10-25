/**
 * `?search=%` must find nothing, not everything.
 *
 * Thirteen repositories interpolated the search term straight into a LIKE pattern, so `%` and `_`
 * kept their wildcard meaning inside the VALUE. Both styles parameterized, so this was never an
 * injection — but `?search=%` became the pattern `%%%` and matched every row in the table, and a
 * reader searching for a literal underscore got matches unrelated to what they typed. Every reference
 * code in this product contains an underscore.
 *
 * WHY AN E2E. `search.spec.ts` proves the pattern is escaped and `search-escaping.ratchet.spec.ts`
 * proves nobody hand-rolls one, and neither proves the DATABASE now agrees. The escape character has
 * to be the one Postgres treats as an escape by default — get that wrong and the pattern is escaped
 * for a dialect nobody is running. Only a real query answers that.
 *
 * Prereqs: `docker compose -f docker-compose.dev.yml up -d` and `pnpm db:seed`.
 */
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURE, authHeaders, createTestApp, login, type Session } from './support/harness';

let app: NestFastifyApplication;
let admin: Session;

/** An asset tag holding both wildcard characters as literal text. */
const LITERAL_TAG = `E2E_EDGE-${Date.now()}%X`;

beforeAll(async () => {
  app = await createTestApp();
  admin = await login(app, FIXTURE.ADMIN);

  /*
   * TWO assets, and the second one matters. Every assertion below compares a search result against
   * the unfiltered total, and with only the wildcard fixture present "matched everything" and "matched
   * one row" are the same number — so the unescaped code would pass.
   */
  for (const payload of [
    {
      assetTag: LITERAL_TAG,
      type: 'laptop',
      model: 'Wildcard Edge Case',
      serialNumber: `SN-A-${Date.now()}`,
    },
    {
      assetTag: `E2E-PLAIN-${Date.now()}`,
      type: 'laptop',
      model: 'Ordinary Control Row',
      serialNumber: `SN-B-${Date.now()}`,
    },
  ]) {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/assets',
      headers: authHeaders(admin),
      payload,
    });
    expect(created.statusCode, created.body).toBeLessThan(300);
  }
});

afterAll(async () => {
  await app?.close();
});

/** `{ total }` for a search term, or for no term at all. */
async function search(term?: string): Promise<{ total: number; tags: string[] }> {
  const query = term === undefined ? '' : `&search=${encodeURIComponent(term)}`;
  const res = await app.inject({
    method: 'GET',
    url: `/v1/assets?limit=50${query}`,
    headers: authHeaders(admin),
  });
  expect(res.statusCode, res.body).toBe(200);
  // `pageInfo.total`, not a top-level `total` — that is the envelope `buildPageResult` produces.
  const body = JSON.parse(res.body) as {
    pageInfo: { total: number };
    data: { assetTag: string }[];
  };
  return { total: body.pageInfo.total, tags: body.data.map((a) => a.assetTag) };
}

describe('search treats wildcards as text', () => {
  it('has assets to find, so the assertions below are not vacuous', async () => {
    // Without this, "a search returns nothing" would be true of an empty table and would pass against
    // the unescaped code as readily as the escaped code.
    const all = await search();
    expect(all.total).toBeGreaterThan(1);
  });

  it('finds nothing for a bare percent, where it used to return the whole table', async () => {
    const all = await search();
    const wildcard = await search('%');

    /*
     * THE REPORTED DEFECT, stated as the difference it makes. Unescaped, this asked for `%%%` and
     * matched everything, so `wildcard.total` equalled `all.total` and the screen looked like a
     * working search. Escaped, `%` is a literal character, and the only row containing one is the
     * fixture created above.
     */
    expect(wildcard.total).toBeLessThan(all.total);
    expect(wildcard.tags).toEqual([LITERAL_TAG]);
  });

  it('finds nothing for a bare underscore either', async () => {
    const all = await search();
    const single = await search('_');

    // The quieter half of the same bug: `%_%` matches any row with at least one character in the
    // column, so it also read as a working search returning almost the whole table.
    expect(single.total).toBeLessThan(all.total);
    expect(single.tags).toEqual([LITERAL_TAG]);
  });

  it('matches an underscore as the character the reader typed', async () => {
    // `E2E_EDGE` unescaped also matches `E2E-EDGE`, `E2EXEDGE` and so on. Here it must match the
    // literal only — the case that makes every reference code in the product searchable.
    const found = await search('E2E_EDGE');
    expect(found.tags).toEqual([LITERAL_TAG]);

    // And the near-miss must NOT match, which is what proves the underscore was treated literally
    // rather than the search merely being narrow.
    const nearMiss = await search('E2E-EDGE');
    expect(nearMiss.tags).not.toContain(LITERAL_TAG);
  });

  it('still finds an ordinary substring', async () => {
    // The regression risk of escaping: over-escape and nothing matches at all. `model` is one of the
    // three columns the asset search covers.
    const found = await search('Wildcard Edge');
    expect(found.tags).toContain(LITERAL_TAG);
  });

  it('treats a blank search as no filter rather than as a match-everything pattern', async () => {
    // `searchAcross` returns `undefined` for a blank term so the filter drops out. Building `%%`
    // instead would reach the original defect from the opposite direction — a caller who typed
    // nothing getting every row by way of a pattern.
    const all = await search();
    const blank = await search('   ');
    expect(blank.total).toBe(all.total);
  });
});
