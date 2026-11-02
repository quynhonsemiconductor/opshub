/// <reference types="node" />
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FAIL_OPEN_FIELD, failOpenLog } from '@quynhonsemiconductor/observability';

/**
 * The log helper itself lives in `@quynhonsemiconductor/observability`. What stays here is the part only
 * THIS repo can assert: that the field name the package emits is the one the fail-open alert (in gitops)
 * filters on, so a package rename fails a test instead of silently disarming the alert.
 *
 * Adopted from rova, which keeps the same spec for the same reason.
 */

const ROOT = join(__dirname, '..', '..', '..', '..');

describe('failOpenLog', () => {
  it('tags the control that degraded', () => {
    expect(failOpenLog('denylist')).toEqual({ securityFailOpen: 'denylist' });
    expect(failOpenLog('rate_limit')).toEqual({ securityFailOpen: 'rate_limit' });
  });

  it('preserves the caller context alongside the tag', () => {
    // The guards pass `{ err }` and, for the rate limiter, the key. Losing that would leave
    // an alarm that fires with nothing to debug it from.
    const err = new Error('valkey unreachable');
    expect(failOpenLog('rate_limit', { err, key: 'IP:127.0.0.1' })).toEqual({
      securityFailOpen: 'rate_limit',
      err,
      key: 'IP:127.0.0.1',
    });
  });

  it('names the field the fail-open alert matches', () => {
    // Pinned as a literal: the alert (in gitops) matches this exact field.
    expect(FAIL_OPEN_FIELD).toBe('securityFailOpen');
  });
});

describe('the fail-open alert keeps matching what the app emits', () => {
  it('both fail-open call sites use the helper rather than a bare object', () => {
    // The rate-limit guard and the identity factory (its sign-in rate limit fails open when Valkey is down) are
    // the only places that fail open. A future one that logs
    // `{ securityFailOpen: 'x' }` by hand would work today and break on the next rename, so
    // this asserts the helper is the single source of the field.
    const callers = execFileSync(
      'git',
      [
        'grep',
        '-l',
        'failOpenLog(',
        '--',
        'libs/modules/identity/src/infrastructure/auth/create-opshub-identity.ts',
        'libs/platform/src/rate-limit/rate-limit.guard.ts',
      ],
      { cwd: ROOT, encoding: 'utf8' },
    )
      .split('\n')
      .filter(Boolean);

    expect(callers).toHaveLength(2);

    // And nothing writes the field name by hand.
    const handRolled = execFileSync(
      'sh',
      [
        '-c',
        `git grep -l "securityFailOpen" -- 'libs/**/*.ts' 'apps/**/*.ts' | grep -v fail-open.spec.ts || true`,
      ],
      { cwd: ROOT, encoding: 'utf8' },
    )
      .split('\n')
      .filter(Boolean);

    expect(
      handRolled,
      `These files write the fail-open field by hand instead of calling failOpenLog(), so a ` +
        `rename in the package would miss them:\n${handRolled.join('\n')}`,
    ).toEqual([]);
  });
});
