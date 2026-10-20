/// <reference types="node" />
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Raw-hex ratchet — the guardrail for the design-token migration.
 *
 * The single source of truth for colour is the token layer: `@theme` in
 * `app/styles/globals.css`, which already defines `--color-accent`, `--color-border`,
 * `--color-danger` and the rest. A raw hex literal (`#a1a1aa`, `text-[#2563eb]`,
 * `style={{ color: '#fff' }}`) bypasses that layer, and bypassing it is how a palette
 * drifts: nothing then keeps light and dark in step, and nothing reports that two pages
 * picked different greys for the same meaning.
 *
 * Unlike rova's, this baseline is NOT zero. opshub has not done the migration — the
 * literals here are hard-coded Tailwind palette values (`#a1a1aa` is zinc-400, `#2563eb`
 * blue-600, `#ef4444` red-500) sitting in chart-heavy pages. Freezing the count is worth
 * doing on its own: it stops the number growing while the migration is pending, which is
 * the entire value rova's docblock claims for it.
 *
 * NEVER raise this number. If a genuinely new palette colour is needed, add it to the token
 * layer in globals.css and reference it — that is the migration, one file at a time.
 *
 * What the migration still needs, and why it is not attempted here: the remaining literals
 * are mostly chart series and SVG paint, which cannot read a CSS custom property directly.
 * rova solved that with a typed mirror of the tokens (`shared/config/brand.ts`) that charts
 * import. opshub has no such mirror yet, so there is nowhere for those values to move to —
 * and changing colours is visually consequential, so it wants someone who can see the
 * result rather than a mechanical edit.
 */

// ── Ratchet baseline — LOWER as files migrate, NEVER raise ────────────────────
//
// Measured by forcing this to -1 and reading the count the failure reports, not by grepping
// alongside — rova's equivalent records that an approximate grep set one of its bars in the
// wrong place, and a baseline above the real count is slack a ratchet cannot have.
const MAX_RAW_HEX = 46;

// src/ root (this file lives in src/app/styles/)
const SRC = join(import.meta.dirname, '../../');

/**
 * Files that define colour in hex BY DESIGN, so every consumer can read from them instead of
 * re-hardcoding. Kept explicit and justified rather than a broad glob, so it stays auditable
 * and cannot silently hide scattered hex.
 *
 * Empty today: opshub has no palette-definition layer in TypeScript — its tokens live in
 * `globals.css`, which this scanner does not read. Add an entry here only for a file that IS
 * the source of truth for its values, never to quiet a violation.
 */
const EXEMPT_FILES = new Set<string>([]);

const HEX = /#[0-9a-fA-F]{3,8}\b/g;

function sourceFiles(): string[] {
  return (
    readdirSync(SRC, { recursive: true, encoding: 'utf8' })
      .filter((f) => /\.(ts|tsx)$/.test(f))
      .filter((f) => !/\.(test|spec)\.(ts|tsx)$/.test(f))
      .filter((f) => !/\.d\.ts$/.test(f))
      // Generated from the OpenAPI spec, so nothing here is hand-written drift.
      .filter((f) => !f.startsWith(join('shared', 'api', 'generated')))
      .filter((f) => !EXEMPT_FILES.has(f.split(/[\\/]/).join('/')))
  );
}

function countRawHex(): { total: number; byFile: Record<string, number> } {
  const byFile: Record<string, number> = {};
  let total = 0;
  for (const rel of sourceFiles()) {
    const abs = join(SRC, rel);
    const matches = readFileSync(abs, 'utf8').match(HEX);
    if (matches?.length) {
      byFile[relative(SRC, abs).split(/[\\/]/).join('/')] = matches.length;
      total += matches.length;
    }
  }
  return { total, byFile };
}

describe('design-token ratchet: no new raw hex colours', () => {
  it('finds the source surface it claims to guard', () => {
    // A scanner that stops seeing files reports a clean zero, which is indistinguishable
    // from a completed migration.
    expect(
      sourceFiles().length,
      'Found almost no source files. The scanner is broken, not the styles.',
    ).toBeGreaterThanOrEqual(50);
  });

  it(`keeps raw hex literal count <= ${MAX_RAW_HEX} (only ever decrease)`, () => {
    const { total, byFile } = countRawHex();
    if (total > MAX_RAW_HEX) {
      const worst = Object.entries(byFile)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([f, n]) => `  ${n.toString().padStart(3)}  ${f}`)
        .join('\n');
      throw new Error(
        `Raw hex colour count rose to ${total} (baseline ${MAX_RAW_HEX}). Use a token from ` +
          `globals.css instead of a raw hex literal — do not raise the baseline. ` +
          `Worst files:\n${worst}`,
      );
    }
    expect(total).toBeLessThanOrEqual(MAX_RAW_HEX);
  });
});
