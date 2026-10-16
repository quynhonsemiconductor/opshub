/**
 * One range rule for the shared packages: every `@quynhonsemiconductor/*` dependency is a caret range (`^x.y.z`).
 *
 * Why caret and not an exact pin: these are our own packages, released independently and often, and Renovate groups their updates into one PR
 * (`qnsc platform packages`). An exact pin made a package silently lag behind its siblings (platform-http stayed at 4.3.0 while platform-runtime
 * moved) and turned every patch into a PR for no gain; the lockfile already fixes what is installed. A caret does not cross a `0.x` minor
 * (`^0.5.0` stays below 0.6.0), so a breaking release of a `0.x` package is still a deliberate bump.
 *
 * What a caret does NOT do is keep a peer satisfied: that is `scripts/check-qnsc-peers.mjs`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const MANIFESTS = ['package.json', 'apps/web/package.json'];
const SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const;

interface Manifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

describe('@quynhonsemiconductor/* dependency ranges', () => {
  it.each(MANIFESTS)('%s uses a caret range for every shared package', (file) => {
    const manifest = JSON.parse(readFileSync(join(ROOT, file), 'utf8')) as Manifest;
    const offenders = SECTIONS.flatMap((section) =>
      Object.entries(manifest[section] ?? {})
        .filter(
          ([name, range]) =>
            name.startsWith('@quynhonsemiconductor/') && !/^\^\d+\.\d+\.\d+$/.test(range),
        )
        .map(([name, range]) => `${section}: ${name}@${range}`),
    );
    expect(
      offenders,
      'use ^x.y.z for @quynhonsemiconductor/* (see the header of this spec)',
    ).toEqual([]);
  });
});
