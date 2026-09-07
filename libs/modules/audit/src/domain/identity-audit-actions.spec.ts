/**
 * The shared identity package's audit vocabulary must be a SUBSET of opshub's catalogue.
 *
 * `@quynhonsemiconductor/identity` records auth events (login, logout, workspace switch, token-theft
 * detection, role elevation) through `AuditServiceAdapter`, and its `AuditRecordInput.action`
 * is a plain `string` — the package does not share opshub's union. So the adapter narrows,
 * and a narrowing assertion is a promise that nothing checks.
 *
 * This reads the package's own compiled output and fails when it emits an action the
 * catalogue does not declare, which turns a dependency bump that adds an auth event into a
 * test failure instead of a row in `audit_logs` whose action appears nowhere in the code.
 *
 * Same technique as rally's `fail-open.spec.ts`, which greps `infra/live/*` to prove the
 * field the package emits is the field the alarm filters on: read the other side's artefact,
 * do not restate its contents.
 */
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { AUDIT_ACTION, AUDIT_RESOURCE } from './audit-catalogue';

/** Literal `action:`/`resourceType:` values in the package's shipped JavaScript. */
function emittedValues(field: 'action' | 'resourceType'): string[] {
  // grep over dist rather than importing: these are inline literals at call sites, not
  // exported constants, so there is nothing to import.
  const out = execFileSync(
    'sh',
    [
      '-c',
      `grep -rhoE "${field}: ['\\"][a-z._]+['\\"]" node_modules/@quynhonsemiconductor/identity/dist 2>/dev/null || true`,
    ],
    { encoding: 'utf8' },
  );
  const values = new Set<string>();
  for (const line of out.split('\n')) {
    const m = /['"]([a-z._]+)['"]/.exec(line);
    if (m) values.add(m[1]);
  }
  return [...values].sort();
}

describe('@quynhonsemiconductor/identity audit vocabulary is declared in the catalogue', () => {
  it('finds the package output it claims to read', () => {
    // A grep that matches nothing reports no violations, which is indistinguishable from a
    // package whose every action is declared.
    expect(
      emittedValues('action').length,
      'Found no audit actions in @quynhonsemiconductor/identity/dist. The scanner is broken, or the ' +
        'package stopped recording auth events — check which before touching the catalogue.',
    ).toBeGreaterThanOrEqual(6);
  });

  it('declares every action the package emits', () => {
    const declared = new Set<string>(Object.values(AUDIT_ACTION));
    const undeclared = emittedValues('action').filter((a) => !declared.has(a));

    expect(
      undeclared,
      `@quynhonsemiconductor/identity emits audit actions that AUDIT_ACTION does not declare:\n  ` +
        `${undeclared.join('\n  ')}\n\nAdd them to the shared-package section of ` +
        `audit-catalogue.ts. AuditServiceAdapter asserts its input is an AuditAction, so an ` +
        `undeclared one is written to audit_logs under a name that appears nowhere in code.`,
    ).toEqual([]);
  });

  it('declares every resource type the package emits', () => {
    const declared = new Set<string>(Object.values(AUDIT_RESOURCE));
    const undeclared = emittedValues('resourceType').filter((r) => !declared.has(r));

    expect(undeclared, `Undeclared resource types from @quynhonsemiconductor/identity`).toEqual([]);
  });
});
