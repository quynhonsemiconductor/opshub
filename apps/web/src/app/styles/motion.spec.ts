/// <reference types="node" />
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { compile } from 'tailwindcss';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * Motion contract — every animation class in the tree must generate CSS.
 *
 * WHY THIS RUNS THE REAL COMPILER. `Modal`, `ConfirmDialog` and the command palette carried
 * `animate-in fade-in-0 zoom-in-95 duration-150` for months. Every one of those names is real
 * `tailwindcss-animate` syntax, the plugin was never a dependency, and there were no `@keyframes`
 * anywhere — so three dialogs asked for motion and Tailwind emitted nothing. The class strings
 * looked correct in review, in the DOM, and to any assertion that reads `className`. That is the
 * whole shape of the bug: an assertion about the class string could not have caught it, because
 * the class string was never wrong. Only the stylesheet was.
 *
 * So this spec compiles `globals.css` with Tailwind itself and asks what CSS came out. A class
 * that produces no rule fails. `environment: 'node'` (the project default) is right for it — this
 * is a stylesheet question, and jsdom implements neither `@media` matching nor `@keyframes`, so
 * the reduced-motion behaviour is NOT expressible there. It is asserted here instead, against the
 * emitted CSS, which is where it actually lives.
 */

const STYLES_DIR = import.meta.dirname;
const GLOBALS = join(STYLES_DIR, 'globals.css');
// src/ root (this file lives in src/app/styles/)
const SRC = resolve(STYLES_DIR, '../../');

const require_ = createRequire(import.meta.url);

/**
 * Motion utilities, in both idioms: this repo's `animate-<token>` and the
 * `tailwindcss-animate` family (`fade-in-0`, `zoom-in-95`, `slide-in-from-top-2`) that a copied
 * snippet brings in. Both are collected because the point is to prove they RESOLVE, and the
 * second family resolves to nothing.
 *
 * Deliberately excludes `[` and `/`, so every candidate is also a valid CSS class selector with
 * no escaping — an arbitrary `animate-[…]` value would need `CSS.escape` and there are none.
 */
const MOTION_CANDIDATE =
  /\b(?:animate-[a-z][a-z0-9-]*|(?:fade|zoom|slide|spin)-(?:in|out)-[a-z0-9-]+)\b/g;
/** Quoted string literals — `className` content, `cn(...)` arguments, class maps. */
const STRING_LITERAL = /'([^'\n]*)'|"([^"\n]*)"/g;

/**
 * Comments are stripped BEFORE scanning, because the three fixed components explain in prose
 * which dead classes they replaced. Scanning the comment would report the bug as still present.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function sourceFiles(): string[] {
  return readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .filter((f) => /\.tsx?$/.test(f))
    .filter((f) => !/\.(test|spec)\.tsx?$/.test(f))
    .filter((f) => !f.startsWith(join('shared', 'api', 'generated')));
}

/** Every motion utility written anywhere in `src/`, mapped to the files that use it. */
function motionUsage(): Map<string, string[]> {
  const usage = new Map<string, string[]>();
  for (const rel of sourceFiles()) {
    const code = stripComments(readFileSync(join(SRC, rel), 'utf8'));
    for (const literal of code.matchAll(STRING_LITERAL)) {
      for (const [candidate] of (literal[1] ?? literal[2] ?? '').matchAll(MOTION_CANDIDATE)) {
        const files = usage.get(candidate) ?? [];
        if (!files.includes(rel)) files.push(rel);
        usage.set(candidate, files);
      }
    }
  }
  return usage;
}

/**
 * Every `--animate-*` token declared in globals.css, paired with the `@keyframes` name its value
 * starts with. `none` is skipped: that is the reduced-motion override, not a declaration.
 */
function declaredAnimations(): { token: string; keyframes: string }[] {
  const css = readFileSync(GLOBALS, 'utf8');
  return [...css.matchAll(/^\s*(--animate-[a-z0-9-]+):\s*([a-z][a-z0-9-]*)/gm)]
    .filter(([, , value]) => value !== 'none')
    .map(([, token, keyframes]) => ({ token, keyframes }));
}

/**
 * Compiles globals.css exactly as the Vite plugin does, resolving `@import 'tailwindcss'` out of
 * node_modules, then emits the rules for `candidates`. No source scanning, so it is fast and the
 * candidate list is explicit rather than whatever the crawler happened to find.
 */
async function buildCss(candidates: string[]): Promise<string> {
  const compiler = await compile(readFileSync(GLOBALS, 'utf8'), {
    base: STYLES_DIR,
    loadStylesheet: async (id, base) => {
      const path = id.startsWith('.')
        ? resolve(base, id)
        : require_.resolve(id.endsWith('.css') ? id : `${id}/index.css`);
      return { path, base: dirname(path), content: readFileSync(path, 'utf8') };
    },
  });
  return compiler.build(candidates);
}

let usage: Map<string, string[]>;
let css: string;

beforeAll(async () => {
  usage = motionUsage();
  // Declared tokens are built alongside the used classes, because Tailwind tree-shakes `@keyframes`
  // with the utility. Without this, a token nobody has wired up yet reports "keyframes nothing
  // defines" — a true failure with a misleading reason.
  css = await buildCss([
    ...usage.keys(),
    ...declaredAnimations().map(({ token }) => token.replace('--animate-', 'animate-')),
  ]);
}, 30_000);

describe('motion tokens generate CSS', () => {
  it('finds the motion classes it claims to guard', () => {
    // A scanner that stops matching reports a clean pass, which is indistinguishable from a tree
    // with no dead animation classes in it.
    expect(sourceFiles().length).toBeGreaterThanOrEqual(50);
    expect(
      [...usage.keys()],
      'No animation utility found in src/. The scanner is broken.',
    ).not.toHaveLength(0);
  });

  it('emits a rule for every animation utility used in src/', () => {
    const dead = [...usage.entries()].filter(([candidate]) => !css.includes(`.${candidate} {`));
    expect(
      dead.map(([candidate, files]) => `${candidate} — used by ${files.join(', ')}`),
      'These classes generate NO CSS. Either define an `--animate-*` token plus `@keyframes` in ' +
        'globals.css, or delete the class: a decorative class name is the bug this spec exists for.',
    ).toEqual([]);
  });

  it('emits @keyframes for every animation the tokens name', () => {
    const declared = declaredAnimations();
    expect(declared.length, 'No --animate-* token found in globals.css.').toBeGreaterThan(0);
    const undefined_ = declared.filter(
      ({ keyframes }) => !css.includes(`@keyframes ${keyframes} {`),
    );
    expect(
      undefined_.map(({ token, keyframes }) => `${token} names @keyframes ${keyframes}`),
      'A token names keyframes nothing defines, so the utility sets `animation` to a name the ' +
        'browser cannot resolve — visually identical to no animation at all.',
    ).toEqual([]);
  });

  it('animates the dialog surface the three overlays share', () => {
    // The token indirection is what reduced motion switches off below; `inline` would bake the
    // value into the utility and there would be nothing left to override.
    expect(css).toContain('.animate-dialog-in {\n    animation: var(--animate-dialog-in);');
    expect(css).toContain('--animate-dialog-in: dialog-in');
  });
});

describe('prefers-reduced-motion', () => {
  /** The `@media (prefers-reduced-motion: reduce)` block, from the emitted CSS. */
  function reducedMotionBlock(): string {
    const start = css.indexOf('@media (prefers-reduced-motion: reduce)');
    expect(start, 'No prefers-reduced-motion block survived into the emitted CSS.').toBeGreaterThan(
      -1,
    );
    // Emitted CSS is indented, so the first `}` at column 0 closes the media block.
    return css.slice(start, css.indexOf('\n}', start) + 2);
  }

  it('switches off every animation token, not just the ones that exist today', () => {
    const block = reducedMotionBlock();
    const missing = declaredAnimations()
      .map(({ token }) => token)
      .filter((token) => !block.includes(`${token}: none`));
    expect(
      missing,
      'A new --animate-* token was added without a `none` override under ' +
        'prefers-reduced-motion. Add it to the reduced-motion block in globals.css — a zooming ' +
        'dialog can trigger vestibular symptoms, so this is not optional.',
    ).toEqual([]);
  });

  it('collapses transitions too, which have no token to override', () => {
    // SlideOver's 300ms transform and every `transition-colors` hover are reachable only this way.
    expect(reducedMotionBlock()).toContain('transition-duration: 0.01ms !important');
  });
});
