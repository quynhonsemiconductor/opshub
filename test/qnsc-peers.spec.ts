/**
 * `scripts/check-qnsc-peers.mjs`: an installed @quynhonsemiconductor/* package whose peer dependency this product does not satisfy fails
 * the build, instead of a pnpm warning nobody reads.
 *
 * The incident this exists for: platform-runtime 0.2.0 peers on platform-cache >=3.2.0 (ExclusiveJob calls CacheService.tryLock); the product
 * pinned ^3.1.1 and resolved 3.1.x. Install, typecheck and every test passed; every ExclusiveJob-guarded job then failed in develop.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

interface Checker {
  satisfies: (version: string, range: string) => boolean;
  findUnmetPeers: (root: string) => string[];
}

const load = async (): Promise<Checker> =>
  (await import(
    pathToFileURL(resolve(__dirname, '../scripts/check-qnsc-peers.mjs')).href
  )) as Checker;

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A throwaway product: one @quynhonsemiconductor package with the given peers, and the given installed versions. */
function product(opts: {
  peers: Record<string, string>;
  optional?: string[];
  installed: Record<string, string>;
}): string {
  const root = mkdtempSync(join(tmpdir(), 'qnsc-peers-'));
  made.push(root);
  const write = (dir: string, json: object): void => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify(json));
  };
  write(join(root, 'node_modules/@quynhonsemiconductor/platform-runtime'), {
    name: '@quynhonsemiconductor/platform-runtime',
    version: '0.2.0',
    peerDependencies: opts.peers,
    peerDependenciesMeta: Object.fromEntries(
      (opts.optional ?? []).map((n) => [n, { optional: true }]),
    ),
  });
  for (const [name, version] of Object.entries(opts.installed)) {
    write(join(root, 'node_modules', name), { name, version });
  }
  return root;
}

describe('check-qnsc-peers', () => {
  it('this product satisfies every peer of the @quynhonsemiconductor packages it installs', async () => {
    const { findUnmetPeers } = await load();
    expect(findUnmetPeers(resolve(__dirname, '..'))).toEqual([]);
  });

  it('fails on the incident: platform-cache 3.1.1 installed, platform-runtime needs >=3.2.0', async () => {
    const { findUnmetPeers } = await load();
    const root = product({
      peers: { '@quynhonsemiconductor/platform-cache': '>=3.2.0' },
      installed: { '@quynhonsemiconductor/platform-cache': '3.1.1' },
    });
    const problems = findUnmetPeers(root);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(
      /platform-runtime@0\.2\.0 needs @quynhonsemiconductor\/platform-cache >=3\.2\.0, but 3\.1\.1 is installed/,
    );
  });

  it('passes once platform-cache is 3.2.0 (the control for the case above)', async () => {
    const { findUnmetPeers } = await load();
    const root = product({
      peers: { '@quynhonsemiconductor/platform-cache': '>=3.2.0' },
      installed: { '@quynhonsemiconductor/platform-cache': '3.2.0' },
    });
    expect(findUnmetPeers(root)).toEqual([]);
  });

  it('fails on a missing required peer and accepts a missing OPTIONAL one', async () => {
    const { findUnmetPeers } = await load();
    const required = product({ peers: { fastify: '>=5' }, installed: {} });
    expect(findUnmetPeers(required)[0]).toMatch(/needs fastify >=5, but it is not installed/);
    const optional = product({ peers: { fastify: '>=5' }, optional: ['fastify'], installed: {} });
    expect(findUnmetPeers(optional)).toEqual([]);
  });

  it('fails loudly on a range form it does not understand, rather than passing it', async () => {
    const { findUnmetPeers } = await load();
    const root = product({ peers: { zod: 'github:foo/bar' }, installed: { zod: '4.1.0' } });
    expect(findUnmetPeers(root)[0]).toMatch(/unsupported peer range/);
  });

  it.each([
    ['3.2.0', '>=3.2.0', true],
    ['3.1.1', '>=3.2.0', false],
    ['4.0.0', '>=3.2.0', true],
    ['0.5.0-pr.245.abc', '>=0.5.0', true],
    ['0.45.2', '>=0.45.2 <1', true],
    ['1.0.0', '>=0.45.2 <1', false],
    ['0.44.9', '>=0.45 <1', false],
    ['3.4.0', '^3.2.0', true],
    ['4.0.0', '^3.2.0', false],
    ['0.5.3', '^0.5.0', true],
    ['0.6.0', '^0.5.0', false],
    ['5.2.1', '~5.2.0', true],
    ['5.3.0', '~5.2.0', false],
    ['1.2.3', '1.2.3', true],
    ['1.2.4', '1.2.3', false],
    ['11.2.7', '>=11', true],
    ['2.0.0', '^1 || ^2', true],
    ['3.0.0', '^1 || ^2', false],
    ['1.0.0', '*', true],
  ])('satisfies(%s, %s) is %s', async (version, range, expected) => {
    const { satisfies } = await load();
    expect(satisfies(version, range)).toBe(expected);
  });
});
