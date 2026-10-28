/**
 * Audit-write ratchet — an audit entry must be atomic with the change it records, and must be
 * written from the layer that owns the transaction.
 *
 * WHAT WAS WRONG
 * --------------
 * All 80 audit calls were `void this.audit.record({...})`: fire-and-forget, outside any
 * transaction, and `AuditService.record` swallowed the failure. So a mutation could commit
 * with no entry, and nothing anywhere would say so.
 *
 * Worse, 40 of them were in CONTROLLERS, duplicating a call the service already made for the
 * same event. A controller cannot join the service's transaction, so those could never be
 * atomic — and because both layers wrote, every one of those events was recorded TWICE.
 * Measured, not inferred:
 *   - `POST /employees`   → 2 rows, both `employee.created`, same `resource_id`
 *   - `POST /authz/roles` → `role.created` AND the controller's old `rbac.role_created`
 *   - `POST /compliance/software` → `software.added` AND `compliance.software_added`
 * Three more pairs (timesheet, leave and overtime approve/reject) were hidden behind
 * ternaries, so no grep for `action: '...'` found them — the typed catalogue did, as compile
 * errors.
 *
 * TWO NUMBERS, BOTH FALLING
 * -------------------------
 * `CONTROLLER_AUDIT_SITES` is an allowlist: each remaining entry is a controller whose
 * service counterpart does not exist yet, so moving the call needs a service method first.
 * An allowlist rather than a count because whoever adds a controller audit call has to name
 * it, which is the judgement a reviewer needs.
 *
 * `FIRE_AND_FORGET_BASELINE` is a plain count that may only fall. The remaining sites are in
 * services whose repositories do not accept a `tx` yet, so converting them is a repository
 * signature change per module rather than a one-line edit — tracked separately, and this
 * number is how progress is measured.
 *
 * 55 → 18: every SERVICE has been converted — identity, assets, access-requests, catalog, license,
 * compliance, authz-admin and workforce. Their repository mutations take an optional `tx` and each service
 * wraps the change and its entry in one transaction. What stays outside one is named at each site: Valkey
 * session revocation, an S3 delete, and the `RequestEngine` submissions where the engine owns the only
 * write and there is no transaction of ours to join.
 *
 * The 18 that remain are the 15 in the allowlisted controllers above, `AuditService`'s own write, and two
 * more in the same controllers — all blocked on a service method that does not exist yet, not on this
 * pattern.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// `__dirname`, matching the other ratchets: this project's tsconfig module setting rejects
// `import.meta`, and vitest transpiles it away so only `tsc -b` sees the error.
const ROOT = join(__dirname, '..');

/**
 * Controllers still writing audit entries, and why each one cannot move down yet.
 *
 * Entries may be REMOVED, never added. Removing one means the call moved into the service
 * that owns the mutation — which is also where a `tx` becomes available.
 */
const CONTROLLER_AUDIT_SITES = new Set<string>([
  // Wraps DelegationService, which lives in libs/platform. Platform cannot import a module,
  // so auditing this needs either an authz-module wrapper or DelegationService taking a tx.
  'authz.controller.ts',
  // RequestEngine is in libs/platform too — same constraint as delegation above.
  'requests.controller.ts',
  // WebhookService has no method for these; the controller composes the repository calls.
  'webhooks.controller.ts',
  // compliance.service has no resolveFinding / triggerScan entry point yet.
  'compliance.controller.ts',
  // workforce.service covers leave/onboarding but not the timesheet, shift and overtime
  // create/submit paths the controller drives directly.
  'workforce.controller.ts',
]);

/**
 * `void this.audit.record(...)` calls that are still fire-and-forget.
 *
 * MAY ONLY FALL. Every one is a mutation that can commit with no audit entry. Reaching 0
 * means every audit write shares its mutation's transaction.
 */
const FIRE_AND_FORGET_BASELINE = 17;

function sourceFiles(): string[] {
  return (
    execFileSync('git', ['ls-files', '*.ts'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
      .filter((f) => !f.endsWith('.spec.ts'))
      // `git ls-files` reports the INDEX, so a file deleted but not yet staged would throw
      // ENOENT here and kill the check with an error that looks nothing like an audit problem.
      .filter((f) => existsSync(join(ROOT, f)))
  );
}

/**
 * Count the two ways a service writes an audit entry.
 *
 * `this.audit.record(...)` is the direct call; `<name>Trail.record(...)` is the resource-bound form from
 * `AuditService.forResource`, which is what a converted site looks like. Counting only the first was fine
 * while every site used it — and would have quietly stopped guarding ANYTHING as sites converted, because a
 * scanner that finds nothing reports no violations. Measured: 55 direct calls became 18 direct plus 37
 * bound, and the "scanner is broken" floor below is what would have caught the omission.
 */
const TRAIL_WRITE = /\bthis\.\w*[Tt]rail\.record\(/g;

function auditWriters(): { file: string; source: string; calls: number }[] {
  return sourceFiles()
    .map((file) => {
      const source = readFileSync(join(ROOT, file), 'utf8');
      const direct = source.split('this.audit.record(').length - 1;
      const bound = source.match(TRAIL_WRITE)?.length ?? 0;
      return { file, source, calls: direct + bound };
    })
    .filter(({ calls }) => calls > 0);
}

describe('audit entries are atomic with the change they record', () => {
  it('finds the audit writers it claims to guard', () => {
    // A scanner that stops seeing audit calls reports no violations, which is
    // indistinguishable from a codebase where every write is already transactional.
    const total = auditWriters().reduce((n, w) => n + w.calls, 0);
    expect(
      total,
      'Found almost no audit writes. The scanner is broken, not the audit trail.',
    ).toBeGreaterThanOrEqual(40);
  });

  it('has no audit write in a controller outside the declared allowlist', () => {
    const offenders = auditWriters()
      .filter(({ file }) => file.endsWith('.controller.ts'))
      .map(({ file }) => file)
      .filter((file) => !CONTROLLER_AUDIT_SITES.has(file.split('/').pop()!));

    expect(
      offenders,
      `These controllers write audit entries. A controller cannot join the service's ` +
        `transaction, so the entry cannot be atomic — and if the service also records the ` +
        `event, the trail gets two rows for one action:\n  ${offenders.join('\n  ')}\n\n` +
        `Move the call into the service that owns the mutation and pass its tx.`,
    ).toEqual([]);
  });

  it('declares no controller that has stopped writing audit entries', () => {
    // Keeps the allowlist honest in the other direction: a stale entry would silently permit
    // a new violation in a file someone had already fixed.
    const writing = new Set(
      auditWriters()
        .filter(({ file }) => file.endsWith('.controller.ts'))
        .map(({ file }) => file.split('/').pop()!),
    );
    const stale = [...CONTROLLER_AUDIT_SITES].filter((f) => !writing.has(f));

    expect(
      stale,
      `These files are allowlisted but no longer write audit entries. Remove them from ` +
        `CONTROLLER_AUDIT_SITES:\n  ${stale.join('\n  ')}`,
    ).toEqual([]);
  });

  it('has no more fire-and-forget audit writes than the baseline', () => {
    const offenders = auditWriters().flatMap(({ file, source }) => {
      const n = source.split('void this.audit.record(').length - 1;
      return n > 0 ? [`${file} (${n})`] : [];
    });
    const total = offenders.reduce((n, o) => n + Number(/\((\d+)\)$/.exec(o)![1]), 0);

    expect(
      total,
      `Fire-and-forget audit writes went UP (${total} > ${FIRE_AND_FORGET_BASELINE}). Each ` +
        `one is a mutation that can commit with no audit entry, because ` +
        `AuditService.record swallows the failure when it has no transaction:\n  ` +
        `${offenders.join('\n  ')}\n\nPass the caller's tx instead.`,
    ).toBeLessThanOrEqual(FIRE_AND_FORGET_BASELINE);
  });

  it('keeps the baseline tight enough to measure', () => {
    // A baseline that drifts above the real count stops measuring anything — the same
    // failure rova's coverage floors had when they sat 11 points under real coverage.
    const total = auditWriters().reduce(
      (n, { source }) => n + source.split('void this.audit.record(').length - 1,
      0,
    );
    expect(
      total,
      `FIRE_AND_FORGET_BASELINE is ${FIRE_AND_FORGET_BASELINE} but the real count is ` +
        `${total}. Lower it to ${total} so the ratchet still catches a regression.`,
    ).toBe(FIRE_AND_FORGET_BASELINE);
  });
});
