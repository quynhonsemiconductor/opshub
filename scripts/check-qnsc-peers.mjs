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
import semver from 'semver';

const SCOPE = '@quynhonsemiconductor';

/**
 * @returns {boolean} whether `version` satisfies `range`
 * @throws on a version or range semver cannot read
 */
export function satisfies(version, range) {
  if (semver.valid(version) === null) throw new Error(`unreadable installed version "${version}"`);
  if (semver.validRange(range) === null) throw new Error(`unsupported peer range "${range}"`);
  return semver.satisfies(version, range, { includePrerelease: true });
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

/** Every installed package directory of the scope: the root links AND every copy in the pnpm store, de-duplicated by real path. */
function installedCopies(root) {
  const dirs = new Set();
  const add = (scopeDir) => {
    if (!existsSync(scopeDir)) return;
    for (const entry of readdirSync(scopeDir)) dirs.add(realpathSync(join(scopeDir, entry)));
  };
  add(join(root, 'node_modules', SCOPE));
  const store = join(root, 'node_modules', '.pnpm');
  if (existsSync(store)) {
    for (const dir of readdirSync(store)) {
      if (dir.startsWith(`${SCOPE.replace('/', '+')}+`)) add(join(store, dir, 'node_modules', SCOPE));
    }
  }
  return [...dirs].sort();
}

/**
 * @param {string} root the product's root (the directory holding node_modules)
 * @returns {string[]} one message per unmet peer; empty when all are satisfied
 */
export function findUnmetPeers(root) {
  const copies = installedCopies(root);
  if (copies.length === 0) return [`no ${SCOPE}/* packages in ${root}/node_modules: run pnpm install first`];
  const problems = new Set();
  for (const real of copies) {
    const pkgJson = join(real, 'package.json');
    if (!existsSync(pkgJson)) continue;
    const pkg = JSON.parse(readFileSync(pkgJson, 'utf8'));
    const optional = pkg.peerDependenciesMeta ?? {};
    for (const [peer, range] of Object.entries(pkg.peerDependencies ?? {})) {
      const found = installedVersion(peer, real);
      const label = `${pkg.name}@${pkg.version} needs ${peer} ${range}`;
      if (found === undefined) {
        if (!optional[peer]?.optional) problems.add(`${label}, but it is not installed`);
        continue;
      }
      try {
        if (!satisfies(found, range)) problems.add(`${label}, but ${found} is installed`);
      } catch (error) {
        problems.add(`${label}: ${error.message}`);
      }
    }
  }
  return [...problems];
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  const root = resolve(process.argv[2] ?? process.cwd());
  const problems = findUnmetPeers(root);
  if (problems.length > 0) {
    console.error(`Unmet peer dependencies of ${SCOPE}/* packages:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    console.error('\nRaise the product dependency to a version that satisfies the peer, then run pnpm install.');
    process.exit(1);
  }
  console.log(`${SCOPE}/*: every peer dependency is satisfied.`);
}
