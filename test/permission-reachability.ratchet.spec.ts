/// <reference types="node" />
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PERMISSION,
  ROLE,
  ROLE_PERMISSIONS,
  permissionGrants,
  type Permission,
} from '../db/permissions.catalog';

/**
 * A permission must be REACHABLE and it must be REQUIRED.
 *
 * `permissions.spec.ts` already proves every code a guard names exists in the catalogue. That is
 * one direction of one relationship, and three failures fit through the gap:
 *
 *   1. A code required by a route that NO ROLE GRANTS. The route fails closed for everybody but the
 *      `*` holder, and it does so silently — the caller gets a 403 naming a permission nobody can
 *      be given. `webhooks.controller.ts` sat on `rbac.manage` this way: eight endpoints reachable
 *      only by `admin`, while the dedicated `webhooks.manage` was granted to `it-admin` and
 *      required by nothing, so the nav item appeared and every click 403'd.
 *   2. A code granted to a role that NOTHING REQUIRES. The bundle reads as a capability the role
 *      does not actually have, which is the more dangerous direction: an RBAC review passes on a
 *      grant that means nothing.
 *   3. A code in the catalogue that neither side references — dead vocabulary that the next person
 *      autocompletes onto a route.
 *
 * WHY AN ALLOWLIST RATHER THAN A BASELINE COUNT. Some codes are ungranted ON PURPOSE: accepting a
 * residual risk, declassifying an information asset, approving a supplier and signing off a CAPA
 * are separation-of-duties decisions the catalogue deliberately withholds from the role that does
 * the corresponding work. Before this file, "deliberately admin-only" and "somebody forgot to
 * update the bundle" were the same observable state. A count cannot tell them apart; a declared
 * reason can, and it is the same mechanism `@AuthzGap` and `RESTRICTED_TABLES` already use here.
 *
 * __dirname, not import.meta.dirname: this suite runs as CommonJS.
 */

const ROOT = join(__dirname, '..');
const ALL_CODES = Object.values(PERMISSION) as Permission[];

/**
 * Codes that no NON-ADMIN role may hold, and why. Reachable only through the `admin` wildcard.
 *
 * Adding an entry here is a policy decision, not a bookkeeping one — it says "we intend this to be
 * super-admin only". Removing one means a bundle now grants it.
 */
const ADMIN_ONLY: Record<string, string> = {
  // ── separation of duties: the role that does the work must not sign off on it ──────────────
  'risk.accept':
    'accepting a residual risk creates exposure by choice; ISO 27001 asks for a named accountable ' +
    'approver, and `security` already holds risk.manage',
  'information_asset.declassify':
    'the role that classifies information must not be able to reduce that protection unilaterally',
  'vendor.approve':
    'approving a supplier for live use is withheld from the role that assesses them',
  'capa.verify':
    'signing off effectiveness is withheld from the role that manages the corrective action; the ' +
    'per-row check (capa.ownerId === actor.sub) is a separate, narrower guard',

  // ── privilege administration: granting privilege is not a delegable operation ──────────────
  'rbac.manage':
    'defining roles and permissions is the one action that can grant every other one, so it stays ' +
    "with the super-admin. Also the engine's admin-cancel check (RequestEngine.cancel)",
  'role.assign':
    'assigning a role hands out its whole bundle; kept with rbac.manage rather than delegated',
};

/**
 * Codes in the catalogue that nothing REQUIRES, and why they are still here.
 *
 * Both entries are redundant vocabulary rather than broken behaviour, and both want a decision
 * (wire it, or delete the code and the grant) rather than an exemption that ages quietly.
 */
const UNREQUIRED: Record<string, string> = {
  'employee.offboard':
    'duplicates offboarding.approve, which is what POST /workforce/offboarding actually requires. ' +
    'HR holds BOTH, so offboarding works — but this code gates nothing. Delete it and its grant, ' +
    'or move the route onto it',
  'notifications.manage':
    'describes managing preferences for all users; every preference route is @SelfScoped and no ' +
    'admin route exists. Granted to no role either, so it is dead on both sides',
};

/**
 * Source split by SIDE, because the two sides mean different things.
 *
 * Only the BACKEND can require a permission — a decorator, a type-def, or a service check. The SPA
 * merely CLAIMS one: `can('webhooks.manage')` says "the API will accept this", and when it is wrong
 * the nav item renders and every click 403s. Counting a web reference as a requirement is what let
 * the original `webhooks.manage` defect survive an earlier draft of this file: the code was required
 * by nothing, and the nav item gating on it made it look used.
 */
function sourceFiles(side: 'backend' | 'web'): string[] {
  const roots = side === 'web' ? ['apps/web/src'] : ['libs', 'apps/api', 'apps/worker', 'db'];
  return (
    execFileSync('git', ['ls-files', ...roots], { cwd: ROOT, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
      .filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'))
      // Generated client: mentions of a code there are echoes of the API, not requirements.
      .filter((f) => !f.includes('/generated/'))
      // A test naming a code does not make it required — that is how a dead code stays alive.
      .filter((f) => !/\.(spec|e2e)\.tsx?$/.test(f))
      // The catalogue declares codes; it cannot be the thing that requires them.
      .filter((f) => f !== 'db/permissions.catalog.ts')
      // `git ls-files` reports the INDEX, which still lists a file deleted in the working tree but
      // not yet staged — readFileSync then throws ENOENT and the failure looks nothing like a
      // permission problem. Same guard the route-policy and query-ordering ratchets carry.
      .filter((f) => existsSync(join(ROOT, f)))
  );
}

/**
 * Every code referenced by name or by `PERMISSION.KEY` on one side, mapped to its files.
 *
 * Memoized: the scan is 69 codes across ~680 files, and six assertions need it. Rebuilding per call
 * took this suite past the 5s default timeout, which fails identically to a real defect.
 */
const INDEX_CACHE = new Map<string, Map<Permission, string[]>>();

function referenceIndex(side: 'backend' | 'web'): Map<Permission, string[]> {
  const cached = INDEX_CACHE.get(side);
  if (cached) return cached;
  const byKey = new Map<Permission, string>();
  for (const [key, code] of Object.entries(PERMISSION)) byKey.set(code, key);

  const index = new Map<Permission, string[]>(ALL_CODES.map((c) => [c, []]));
  for (const file of sourceFiles(side)) {
    const source = readFileSync(join(ROOT, file), 'utf8');
    for (const code of ALL_CODES) {
      // Either spelling counts: a decorator writes the literal, a type-def writes the constant.
      if (source.includes(`'${code}'`) || source.includes(`PERMISSION.${byKey.get(code)}`)) {
        index.get(code)!.push(file);
      }
    }
  }
  INDEX_CACHE.set(side, index);
  return index;
}

const NON_ADMIN_BUNDLES = Object.entries(ROLE_PERMISSIONS).filter(([role]) => role !== ROLE.ADMIN);

/** Roles other than `admin` that can satisfy `code`, wildcard semantics included. */
function holders(code: Permission): string[] {
  return NON_ADMIN_BUNDLES.filter(([, granted]) =>
    permissionGrants(granted as readonly string[], code),
  ).map(([role]) => role);
}

describe('permission reachability', () => {
  it('finds the catalogue and the source surface it claims to guard', () => {
    // Without this, a broken glob or a renamed export makes every assertion below vacuously true:
    // zero codes are all reachable, and zero files reference nothing.
    expect(ALL_CODES.length).toBeGreaterThan(50);
    expect(NON_ADMIN_BUNDLES.length).toBeGreaterThan(5);
    expect(sourceFiles('backend').length).toBeGreaterThan(300);
    expect(sourceFiles('web').length).toBeGreaterThan(100);

    // And both indexes must actually be finding references — a scan that matched nothing would
    // report every code as dead vocabulary, which is a louder failure, or (if inverted) none at all.
    expect(
      ALL_CODES.filter((c) => referenceIndex('backend').get(c)!.length > 0).length,
    ).toBeGreaterThan(50);
    expect(
      ALL_CODES.filter((c) => referenceIndex('web').get(c)!.length > 0).length,
    ).toBeGreaterThan(20);
  });

  it('every code some route requires is granted to at least one non-admin role', () => {
    const index = referenceIndex('backend');
    // REQUIRED somewhere is part of the condition: a code nothing requires is not "unreachable by
    // its routes", it is dead vocabulary, and the test below is the one that should name it.
    const unreachable = ALL_CODES.filter(
      (c) => !ADMIN_ONLY[c] && index.get(c)!.length > 0 && holders(c).length === 0,
    );

    expect(
      unreachable,
      'These permissions are required somewhere and no role grants them, so the routes behind ' +
        'them answer 403 for every caller but the `*` admin. Either grant each to the role that ' +
        'is supposed to do the work, or declare it in ADMIN_ONLY with the reason:\n  ' +
        unreachable.join('\n  '),
    ).toEqual([]);
  });

  it('every ADMIN_ONLY code is really ungranted, and still exists', () => {
    // Checked BOTH WAYS on purpose. A re-grant is the failure that matters — it widens a
    // separation-of-duties boundary while this file goes on asserting the boundary is intact. A
    // stale entry is the quieter one: an exemption nobody checks.
    const regranted = Object.keys(ADMIN_ONLY)
      .filter((c) => ALL_CODES.includes(c as Permission))
      .filter((c) => holders(c as Permission).length > 0)
      .map((c) => `${c} — now held by ${holders(c as Permission).join(', ')}`);
    expect(
      regranted,
      'ADMIN_ONLY says no non-admin role may hold these, and a bundle now does. If the policy ' +
        'changed, delete the entry and say so in the bundle:\n  ' +
        regranted.join('\n  '),
    ).toEqual([]);

    const stale = Object.keys(ADMIN_ONLY).filter((c) => !ALL_CODES.includes(c as Permission));
    expect(
      stale,
      `ADMIN_ONLY names codes the catalogue no longer defines: ${stale.join(', ')}`,
    ).toEqual([]);
  });

  it('every granted code is required by something', () => {
    const index = referenceIndex('backend');
    const decorative = ALL_CODES.filter(
      (c) => !UNREQUIRED[c] && holders(c).length > 0 && index.get(c)!.length === 0,
    );

    expect(
      decorative,
      'These codes are granted to a role and required by nothing, so the bundle claims a ' +
        'capability the role does not have — an RBAC review would pass on it:\n  ' +
        decorative.join('\n  '),
    ).toEqual([]);
  });

  it('no code is dead on both sides', () => {
    const index = referenceIndex('backend');
    const dead = ALL_CODES.filter(
      (c) => !UNREQUIRED[c] && holders(c).length === 0 && index.get(c)!.length === 0,
    );

    expect(
      dead,
      'These codes are granted to nobody and required by nothing. A dead code is what the next ' +
        'person autocompletes onto a route:\n  ' +
        dead.join('\n  '),
    ).toEqual([]);
  });

  it('every code the SPA gates on is one the API actually requires', () => {
    const backend = referenceIndex('backend');
    const web = referenceIndex('web');
    const unbacked = ALL_CODES.filter(
      (c) => web.get(c)!.length > 0 && backend.get(c)!.length === 0,
    ).map((c) => `${c} — claimed by ${web.get(c)!.join(', ')}`);

    expect(
      unbacked,
      'The SPA gates a control on these codes and no backend route, type-def or service check ' +
        'requires any of them. That is the worst-shaped permission bug available: holding the code ' +
        'reveals the control, and using the control fails. `webhooks.manage` was exactly this — ' +
        'granted to it-admin, gating the nav item, while all eight routes behind it required ' +
        'rbac.manage:\n  ' +
        unbacked.join('\n  '),
    ).toEqual([]);
  });

  it('every UNREQUIRED entry is really unrequired, and still exists', () => {
    const index = referenceIndex('backend');
    const nowUsed = Object.keys(UNREQUIRED)
      .filter((c) => ALL_CODES.includes(c as Permission))
      .filter((c) => index.get(c as Permission)!.length > 0)
      .map((c) => `${c} — now required by ${index.get(c as Permission)!.join(', ')}`);
    expect(
      nowUsed,
      'UNREQUIRED says nothing requires these and something now does. Delete the entry:\n  ' +
        nowUsed.join('\n  '),
    ).toEqual([]);

    const stale = Object.keys(UNREQUIRED).filter((c) => !ALL_CODES.includes(c as Permission));
    expect(
      stale,
      `UNREQUIRED names codes the catalogue no longer defines: ${stale.join(', ')}`,
    ).toEqual([]);
  });
});
