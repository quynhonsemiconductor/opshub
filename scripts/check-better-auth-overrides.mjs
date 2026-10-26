// Fails when the `better-auth>peer: "-"` override list in pnpm-workspace.yaml is not exactly
// better-auth's OPTIONAL peers minus drizzle-orm and pg (the two identity uses).
//
// WHY. better-auth's optional peers must never reach the production tree (`pnpm install --prod`
// follows the optionalDependencies they resolve into: vitest, vite, esbuild ...), and the override
// that keeps them out is only as good as its list. A Better Auth bump that adds or removes a peer
// must fail here until the list is updated — the same tripwire the old `cmp .pnpmfile.cjs` step
// provided. See "Keeping Better Auth's optional peers out of the runtime image" in identity's README.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const KEPT = ['drizzle-orm', 'pg'];

const ws = readFileSync('pnpm-workspace.yaml', 'utf8');
const overridden = [...ws.matchAll(/"better-auth>([^"]+)": "-"/g)].map((m) => m[1]).sort();
if (overridden.length === 0) {
  console.error('pnpm-workspace.yaml declares no "better-auth>peer": "-" overrides');
  process.exit(1);
}

// better-auth is a dependency of @quynhonsemiconductor/identity, so its manifest lives under
// node_modules/.pnpm (there may be several peer-resolution variants; every one must agree).
const pnpmDir = join('node_modules', '.pnpm');
const manifestDirs = readdirSync(pnpmDir).filter((d) => /^better-auth@\d/.test(d));
if (manifestDirs.length === 0) {
  console.error('better-auth is not installed (node_modules/.pnpm has no better-auth@ entry)');
  process.exit(1);
}
const optional = new Set();
const peers = new Set();
for (const dir of manifestDirs) {
  const manifest = JSON.parse(readFileSync(join(pnpmDir, dir, 'node_modules', 'better-auth', 'package.json'), 'utf8'));
  for (const [name, meta] of Object.entries(manifest.peerDependenciesMeta ?? {})) {
    peers.add(name);
    if (meta.optional === true) optional.add(name);
  }
}

const expected = [...optional].filter((p) => !KEPT.includes(p)).sort();
if (JSON.stringify(overridden) !== JSON.stringify(expected)) {
  console.error(
    `the better-auth override list does not match the installed better-auth ${[...manifestDirs].join(', ')}\n` +
      `  overrides: ${overridden.join(', ')}\n` +
      `  expected (optional peers minus ${KEPT.join('/')}): ${expected.join(', ') || '(none)'}\n` +
      'Update the list in pnpm-workspace.yaml (and the snippet in identity\'s README), then re-run pnpm install.',
  );
  process.exit(1);
}
for (const kept of KEPT) {
  if (overridden.includes(kept) || !peers.has(kept)) {
    console.error(`better-auth must keep declaring its ${kept} peer (identity uses it)`);
    process.exit(1);
  }
}
console.log(`ok: ${overridden.length} overrides = better-auth's optional peers minus ${KEPT.join('/')}`);
