/// <reference types="node" />
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FAIL_OPEN_FIELD, failOpenLog } from '@quynhonsemiconductor/observability';

/**
 * The log helper itself lives in `@quynhonsemiconductor/observability`. What stays here is the part only
 * THIS repo can assert — that the field name the package emits is the one this repo's
 * Terraform actually filters on.
 *
 * That coupling is invisible from both sides. The package cannot know which infra matches
 * its output, and the Terraform cannot know which constant produced the field. So a package
 * rename or an infra edit would silently disarm the alarm: the guards keep logging, the
 * metric filter keeps matching nothing, and `SecurityFailOpen` sits at zero looking healthy.
 * The alarm even treats missing data as `notBreaching`, which is right for the real
 * no-events case and precisely why a broken filter cannot be told apart from a quiet one.
 *
 * Adopted from rally, which keeps the same spec for the same reason.
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
    expect(failOpenLog('rate_limit', { err, key: 'AUTH_LOGIN:127.0.0.1' })).toEqual({
      securityFailOpen: 'rate_limit',
      err,
      key: 'AUTH_LOGIN:127.0.0.1',
    });
  });

  it('names the field the CloudWatch filter matches', () => {
    // Pinned as a literal, because the Terraform pattern below is a literal too — a shared
    // constant on both sides is not possible across that boundary.
    expect(FAIL_OPEN_FIELD).toBe('securityFailOpen');
  });
});

describe('the metric filter matches what the app emits', () => {
  it('finds the field name in the stack Terraform', () => {
    // grep the INFRA for the pattern built from the package's constant. If the package
    // renames the field, or the filter is edited or deleted, this fails — which is the whole
    // point, because nothing else would notice.
    const matches = execFileSync(
      'grep',
      ['-rl', '--include=*.tf', '--exclude-dir=.terraform', `$.${FAIL_OPEN_FIELD}`, 'infra'],
      { cwd: ROOT, encoding: 'utf8' },
    )
      .split('\n')
      .filter(Boolean);

    expect(
      matches,
      `No Terraform metric filter matches "$.${FAIL_OPEN_FIELD}". The guards still log it, ` +
        `so the alarm would sit at zero looking healthy. Check ` +
        `aws_cloudwatch_log_metric_filter.security_fail_open in infra/modules/stack/main.tf.`,
    ).not.toHaveLength(0);
  });

  it('both fail-open call sites use the helper rather than a bare object', () => {
    // The two guards are the only places that fail open. A future one that logs
    // `{ securityFailOpen: 'x' }` by hand would work today and break on the next rename, so
    // this asserts the helper is the single source of the field.
    const callers = execFileSync(
      'git',
      ['grep', '-l', 'failOpenLog(', '--', 'libs/platform/src/auth/jwt.guard.ts', 'libs/platform/src/rate-limit/rate-limit.guard.ts'],
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
