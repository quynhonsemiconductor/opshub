#!/usr/bin/env bash
# The production dependency tree holds none of Better Auth's dropped optional peers.
#
# The runtime image's prod-deps stage runs `pnpm install --frozen-lockfile --prod --ignore-scripts`
# from the committed lockfile; this check runs the SAME commands in the working tree and asserts the
# result. better-auth declares 18 OPTIONAL peers; the "better-auth>peer": "-" overrides in
# pnpm-workspace.yaml drop all of them except drizzle-orm and pg, so none of the dropped ones — nor
# anything only they pull in (vite, esbuild ...) — may appear in `pnpm ls --prod`. This is the
# tree-level check; scripts/check-better-auth-overrides.mjs is the list-level tripwire.
#
# Two assertions, so neither can silently stop testing:
#   1. the committed lockfile: better-auth's entries resolve no optionalDependencies beyond the kept two;
#   2. the installed production tree (the command the image runs): no dropped peer is present.
#
# Restores the dev install when it passes. CI=true because switching between dev and prod
# node_modules purges the modules directory and pnpm 11 asks for confirmation outside a TTY.
set -euo pipefail

KEPT='drizzle-orm pg'

echo "== lockfile: better-auth resolves no optional peer beyond the kept two"
node - "$KEPT" <<'NODE'
const fs = require('node:fs');
const kept = process.argv[2].split(' ');
const lines = fs.readFileSync('pnpm-lock.yaml', 'utf8').split('\n');
let section = '';
let entry = '';
let block = '';
const found = [];
const entries = [];
for (const line of lines) {
  if (/^\S/.test(line)) { section = line.replace(/:.*$/, ''); entry = ''; block = ''; continue; }
  const e = /^  (\S.*?):\s*(\{\})?$/.exec(line);
  if (e) { entry = e[1].replace(/^'|'$/g, ''); block = ''; if (/^better-auth@/.test(entry)) entries.push(`${section}:${entry}`); continue; }
  if (!/^better-auth@/.test(entry)) continue;
  const b = /^    (\w+):\s*$/.exec(line);
  if (b) { block = b[1]; continue; }
  const k = /^      ([^ ][^:]*):/.exec(line);
  if (!k) continue;
  const name = k[1].replace(/'/g, '');
  if (block === 'optionalDependencies' && !kept.includes(name)) {
    found.push(`${section}:${entry} ${block}.${name}`);
  }
}
if (entries.length === 0) { console.error('no better-auth entry in the lockfile: the assertion would test nothing'); process.exit(2); }
if (found.length) { console.error(`better-auth resolves optional peers in the lockfile:\n  ${found.join('\n  ')}`); process.exit(1); }
console.log(`ok (${entries.length} better-auth entries)`);
NODE

echo "== production tree: pnpm install --frozen-lockfile --prod --ignore-scripts"
CI=true pnpm install --frozen-lockfile --prod --ignore-scripts
node - "$KEPT" <<'NODE'
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const kept = new Set(process.argv[2].split(' '));
// The peers the overrides drop: better-auth's installed optional peers minus the kept two.
const pnpmDir = require('node:path').join('node_modules', '.pnpm');
const dropped = new Set();
for (const dir of fs.readdirSync(pnpmDir).filter((d) => /^better-auth@\d/.test(d))) {
  const m = JSON.parse(fs.readFileSync(require('node:path').join(pnpmDir, dir, 'node_modules', 'better-auth', 'package.json'), 'utf8'));
  for (const [name, meta] of Object.entries(m.peerDependenciesMeta ?? {})) {
    if (meta.optional === true && !kept.has(name)) dropped.add(name);
  }
}
if (dropped.size === 0) { console.error('better-auth declares no droppable optional peers: the assertion would test nothing'); process.exit(2); }
const input = JSON.parse(execFileSync('pnpm', ['ls', '--prod', '--depth', 'Infinity', '--json']));
const walk = (deps, into) => { for (const [name, d] of Object.entries(deps ?? {})) { into.add(name); walk(d.dependencies, into); walk(d.optionalDependencies, into); } };
// Per workspace project: a dropped peer that the project itself declares as a PROD dependency
// (apps/web's react) is its own dependency, not Better Auth's optional-peer resolution. Scoped
// per project on purpose: a react leak from better-auth into the API tree cannot hide behind
// apps/web's package.json, and vice versa. Everything else that shows up got there THROUGH
// better-auth, which is the leak.
const leaked = [];
for (const project of input) {
  const present = new Set();
  walk(project.dependencies, present);
  walk(project.optionalDependencies, present);
  let own = new Set();
  try {
    own = new Set(Object.keys(JSON.parse(fs.readFileSync(require('node:path').join(project.path, 'package.json'), 'utf8')).dependencies ?? {}));
  } catch {}
  for (const n of dropped) {
    if (present.has(n) && !own.has(n)) leaked.push(`${n} (in ${project.path})`);
  }
}
if (leaked.length) { console.error(`::error::dropped Better Auth peers in the production tree: ${leaked.join(' ')} (pnpm why: pnpm why ${leaked.join(' ')} --prod)`); process.exit(1); }
console.log(`ok: none of the ${dropped.size} dropped peers is in \`pnpm ls --prod --depth Infinity\` beyond each project's own prod dependencies`);
NODE

echo "== restoring the dev install"
CI=true pnpm install --frozen-lockfile
