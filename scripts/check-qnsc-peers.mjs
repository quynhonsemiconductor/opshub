#!/usr/bin/env node
/**
 * Fails when an installed `@quynhonsemiconductor/*` package has a peer dependency the product does not satisfy.
 *
 * WHY. pnpm only WARNS about an unmet peer ("Issues with peer dependencies found"), and warnings scroll past. platform-runtime 0.2.0 peers on
 * platform-cache >=3.2.0 (its ExclusiveJob calls CacheService.tryLock); the product pinned ^3.1.1 and resolved 3.1.x, so install, typecheck and
 * every test passed, and every ExclusiveJob-guarded job then failed on develop with "this.cache.tryLock is not a function".
 *
 * Scope: the peers OF our own packages. Third-party unmet peers (which every large tree has) are not this check's business.
 *
 * Zero dependencies: reads node_modules the way the package itself would resolve its peers (from its real path, walking up).
 * Supported peer ranges: `>=`, `>`, `<=`, `<`, `^`, `~`, an exact version, `*`, whitespace-separated AND (`>=0.45 <1`) and `||`. Anything else FAILS the check, loudly,
 * so a new range form is added here rather than silently passing.
 */
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCOPE = '@quynhonsemiconductor';

/** @returns {[number, number, number] | null} */
function parseVersion(v) {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(v).trim());
  return m ? [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)] : null;
}

function cmp(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

/**
 * Prereleases are compared by their numeric core: `0.5.0-pr.245.abc` counts as 0.5.0, which is the intent of a canary pin.
 * @returns {boolean} whether `version` satisfies `range`
 * @throws on a range form this checker does not understand
 */
export function satisfies(version, range) {
  const v = parseVersion(version);
  if (!v) throw new Error(`unreadable installed version "${version}"`);
  const comparator = (token) => {
    if (token === '*' || token === 'x') return true;
    const m = /^(>=|<=|>|<|=|\^|~)?v?(\d+(?:\.\d+){0,2})(?:-[\w.]+)?$/.exec(token);
    if (!m)
      throw new Error(`unsupported peer range "${range}" (add it to scripts/check-qnsc-peers.mjs)`);
    const base = parseVersion(m[2]);
    switch (m[1] ?? '') {
      case '>=':
        return cmp(v, base) >= 0;
      case '>':
        return cmp(v, base) > 0;
      case '<=':
        return cmp(v, base) <= 0;
      case '<':
        return cmp(v, base) < 0;
      case '^': {
        const upper =
          base[0] > 0
            ? [base[0] + 1, 0, 0]
            : base[1] > 0
              ? [0, base[1] + 1, 0]
              : [0, 0, base[2] + 1];
        return cmp(v, base) >= 0 && cmp(v, upper) < 0;
      }
      case '~':
        return cmp(v, base) >= 0 && cmp(v, [base[0], base[1] + 1, 0]) < 0;
      default:
        return cmp(v, base) === 0;
    }
  };
  // `a || b` is OR; whitespace inside a part is AND (`>=0.45 <1`).
  return String(range)
    .split('||')
    .some((part) => {
      const tokens = part.trim().split(/\s+/).filter(Boolean);
      return tokens.length === 0 || tokens.every(comparator);
    });
}

/** The version of `name` as the package at `fromDir` would resolve it: nearest node_modules/<name> going up from its real path. */
function installedVersion(name, fromDir) {
  let dir = fromDir;
  for (;;) {
    const candidate = join(dir, 'node_modules', name, 'package.json');
    if (existsSync(candidate)) return JSON.parse(readFileSync(candidate, 'utf8')).version;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * @param {string} root the product's root (the directory holding node_modules)
 * @returns {string[]} one message per unmet peer; empty when all are satisfied
 */
export function findUnmetPeers(root) {
  const scopeDir = join(root, 'node_modules', SCOPE);
  if (!existsSync(scopeDir))
    return [`no ${SCOPE}/* packages in ${root}/node_modules: run pnpm install first`];
  const problems = [];
  for (const entry of readdirSync(scopeDir)) {
    const real = realpathSync(join(scopeDir, entry));
    const pkgJson = join(real, 'package.json');
    if (!existsSync(pkgJson)) continue;
    const pkg = JSON.parse(readFileSync(pkgJson, 'utf8'));
    const optional = pkg.peerDependenciesMeta ?? {};
    for (const [peer, range] of Object.entries(pkg.peerDependencies ?? {})) {
      const found = installedVersion(peer, real);
      const label = `${SCOPE}/${entry}@${pkg.version} needs ${peer} ${range}`;
      if (found === undefined) {
        if (!optional[peer]?.optional) problems.push(`${label}, but it is not installed`);
        continue;
      }
      try {
        if (!satisfies(found, range)) problems.push(`${label}, but ${found} is installed`);
      } catch (error) {
        problems.push(`${label}: ${error.message}`);
      }
    }
  }
  return problems;
}

if (
  process.argv[1] &&
  realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))
) {
  const root = resolve(process.argv[2] ?? process.cwd());
  const problems = findUnmetPeers(root);
  if (problems.length > 0) {
    console.error(
      `Unmet peer dependencies of ${SCOPE}/* packages:\n${problems.map((p) => `  - ${p}`).join('\n')}`,
    );
    console.error(
      '\nRaise the product dependency to a version that satisfies the peer, then run pnpm install.',
    );
    process.exit(1);
  }
  console.log(`${SCOPE}/*: every peer dependency is satisfied.`);
}
