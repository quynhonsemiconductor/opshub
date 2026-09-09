/// <reference types="node" />
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PERMISSION,
  PERMISSION_DESCRIPTIONS,
  ROLE,
  ROLE_NAMES,
  ROLE_PERMISSIONS,
  WILDCARD_PERMISSION,
  moduleOf,
  permissionGrants,
  permissionModules,
  type Permission,
} from '../db/permissions.catalog';

/**
 * Catalogue invariants.
 *
 * The catalogue is the single source of truth for permission codes, so the way it
 * fails is by drifting from the things that read it: the seed (which fills the
 * database), the guards (which check codes), and the frontend (which gates the UI).
 * These tests pin the properties that make that drift impossible, plus the
 * wildcard semantics every layer now shares.
 *
 * __dirname, not import.meta.dirname: this suite runs as CommonJS.
 */

const ROOT = join(__dirname, '..');
const ALL_CODES = Object.values(PERMISSION) as Permission[];

describe('permission codes', () => {
  it('are unique', () => {
    expect(new Set<string>(ALL_CODES).size).toBe(ALL_CODES.length);
  });

  it('follow the <module>.<action> convention', () => {
    // The module is DERIVED from the code, so a code with no dot would silently
    // become its own module and never group with anything.
    for (const code of ALL_CODES) {
      expect(code, `${code} needs a module prefix`).toMatch(/^[a-z_]+(\.[a-z_]+)+$/);
    }
  });

  it('never collide with the wildcard', () => {
    expect(ALL_CODES as string[]).not.toContain(WILDCARD_PERMISSION);
  });

  it('all have a description, and no description is orphaned', () => {
    // The seed writes these into authz.permissions.description; a missing one
    // would surface as an empty cell in the RBAC editor.
    expect(Object.keys(PERMISSION_DESCRIPTIONS).sort()).toEqual([...ALL_CODES].sort());
    for (const code of ALL_CODES) {
      expect(PERMISSION_DESCRIPTIONS[code].length, `${code} description`).toBeGreaterThan(0);
    }
  });
});

describe('roles', () => {
  it('every role has a display name and a bundle', () => {
    const keys = Object.values(ROLE).sort();
    expect(Object.keys(ROLE_NAMES).sort()).toEqual(keys);
    expect(Object.keys(ROLE_PERMISSIONS).sort()).toEqual(keys);
  });

  it('grant only codes that exist', () => {
    // The invariant that matters most: a bundle referencing a code the catalogue
    // does not define seeds a row nothing can ever satisfy, so the role looks
    // privileged and is not.
    const valid = new Set<string>([...ALL_CODES, WILDCARD_PERMISSION]);
    for (const [role, granted] of Object.entries(ROLE_PERMISSIONS)) {
      for (const code of granted) {
        expect(valid.has(code), `${role} grants unknown permission ${code}`).toBe(true);
      }
    }
  });

  it('grant no duplicates within a bundle', () => {
    for (const [role, granted] of Object.entries(ROLE_PERMISSIONS)) {
      expect(new Set<string>(granted).size, `${role} has duplicate grants`).toBe(granted.length);
    }
  });

  it('reserve the wildcard for admin alone', () => {
    for (const [role, granted] of Object.entries(ROLE_PERMISSIONS)) {
      if (role === ROLE.ADMIN) {
        expect(granted).toEqual([WILDCARD_PERMISSION]);
      } else {
        expect(granted as readonly string[], `${role} must not hold '*'`).not.toContain(
          WILDCARD_PERMISSION,
        );
      }
    }
  });

  it('leaves the base employee role empty', () => {
    // Self-service access is expressed by the `self` SCOPE on a grant, not by a
    // permission code. An entry creeping in here means someone modelled
    // "my own records" as a capability, which every user would then hold globally.
    expect(ROLE_PERMISSIONS[ROLE.EMPLOYEE]).toEqual([]);
  });
});

describe('moduleOf', () => {
  it('takes the FIRST segment, so sub-namespaces stay in their module', () => {
    expect(moduleOf('workforce.leave.review')).toBe('workforce');
    expect(moduleOf('asset.read')).toBe('asset');
  });

  it('groups every code under a module', () => {
    expect(permissionModules()).toContain('workforce');
    expect(permissionModules().length).toBeGreaterThan(0);
    for (const code of ALL_CODES) {
      expect(permissionModules()).toContain(moduleOf(code));
    }
  });
});

describe('permissionGrants', () => {
  it('denies when nothing is held', () => {
    expect(permissionGrants(undefined, PERMISSION.ASSET_READ)).toBe(false);
    expect(permissionGrants([], PERMISSION.ASSET_READ)).toBe(false);
  });

  it('allows an exact match', () => {
    expect(permissionGrants([PERMISSION.ASSET_READ], PERMISSION.ASSET_READ)).toBe(true);
  });

  it('allows the super-admin wildcard for anything', () => {
    expect(permissionGrants([WILDCARD_PERMISSION], PERMISSION.SECURITY_MANAGE)).toBe(true);
  });

  it('allows a module-wide grant within its module only', () => {
    expect(permissionGrants(['asset.*'], PERMISSION.ASSET_REASSIGN)).toBe(true);
    expect(permissionGrants(['asset.*'], PERMISSION.EMPLOYEE_READ)).toBe(false);
  });

  it('does not let a module wildcard leak across a shared prefix', () => {
    // `access_request.*` must not grant something in a different module that
    // merely starts with the same letters.
    expect(permissionGrants(['access_request.*'], PERMISSION.ASSET_READ)).toBe(false);
  });

  it('keeps the device inventory and the information asset register apart', () => {
    // These two modules genuinely end in the same word, and the device inventory
    // wildcard is held by IT and the service desk. If matching were a prefix or a
    // substring test rather than an exact module comparison, `asset.*` would hand
    // them the classification register — including who owns which personal-data
    // system — and nothing else in the suite would notice.
    expect(permissionGrants(['asset.*'], PERMISSION.INFORMATION_ASSET_READ)).toBe(false);
    expect(permissionGrants(['asset.*'], PERMISSION.INFORMATION_ASSET_DECLASSIFY)).toBe(false);
    // And the reverse: holding the register must not confer the hardware inventory.
    expect(permissionGrants(['information_asset.*'], PERMISSION.ASSET_WRITE)).toBe(false);
    expect(permissionGrants(['information_asset.*'], PERMISSION.INFORMATION_ASSET_READ)).toBe(true);
  });

  it('treats a sub-namespaced code as belonging to its module', () => {
    expect(permissionGrants(['workforce.*'], PERMISSION.WORKFORCE_LEAVE_REVIEW)).toBe(true);
  });
});

describe('the catalogue is the only vocabulary', () => {
  it('no second PERMISSION map is declared anywhere', () => {
    // constants.ts used to declare its own, with `assets.view` where the database
    // has `asset.read`. Nothing imported it, so it broke nothing and would have
    // broken a route the moment someone autocompleted it.
    // `--untracked` so the result does not depend on what happens to be staged —
    // without it a brand-new file is invisible and the test passes for the wrong
    // reason.
    //
    // The boundary is spelled out rather than written `\b`. `git grep -E` is POSIX
    // ERE, where `\b` is a GNU EXTENSION: glibc honours it, so this matched on CI
    // and passed, while BSD's regex does not, so on macOS it matched NOTHING — and
    // no match is also this test's own passing condition, so the check could not
    // run at all on a developer's machine and reported it as a thrown error.
    // `($|[^A-Za-z0-9_])` is the same assertion in a dialect both engines share, so
    // `PERMISSION_DESCRIPTIONS` still does not count as a second map.
    //
    // `spawnSync`, not `execFileSync`: git grep exits 1 to mean "no matches", which
    // is a RESULT here and not a failure. execFileSync turns that exit code into a
    // throw, so the one outcome this test exists to accept arrived as a crash whose
    // message named neither the catalogue nor the file that broke the rule. Anything
    // other than 0 or 1 is still a real fault and is re-thrown.
    const found = spawnSync(
      'git',
      [
        'grep',
        '--untracked',
        '-l',
        '-E',
        'export const PERMISSION($|[^A-Za-z0-9_])',
        '--',
        'libs',
        'apps',
        'db',
      ],
      { cwd: ROOT, encoding: 'utf8' },
    );
    if (found.status !== 0 && found.status !== 1) {
      throw new Error(`git grep failed (${found.status}): ${found.stderr}`);
    }
    const hits = found.stdout.split('\n').filter(Boolean);

    expect(hits).toEqual(['db/permissions.catalog.ts']);
  });

  it('every code a guard requires exists in the catalogue', () => {
    // The decorator is typed, so this cannot fail via the decorator — it catches
    // the ways around the type: a string built at runtime, or a service-level
    // check written by hand.
    const files = execFileSync('git', ['ls-files', 'libs/**/*.ts'], {
      cwd: ROOT,
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean)
      // `git ls-files` reports the INDEX, which still lists a file deleted in the working
      // tree but not yet staged — readFileSync then throws ENOENT and the whole check dies
      // with an error that looks nothing like a permission problem. Same guard the
      // route-policy and query-ordering ratchets carry, for the same reason.
      .filter((f) => existsSync(join(ROOT, f)));

    const valid = new Set<string>([...ALL_CODES, WILDCARD_PERMISSION]);
    const offenders: string[] = [];

    for (const file of files) {
      const source = readFileSync(join(ROOT, file), 'utf8');
      for (const match of source.matchAll(/@RequirePermission\(\s*'([^']+)'/g)) {
        if (!valid.has(match[1])) offenders.push(`${file}: ${match[1]}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
