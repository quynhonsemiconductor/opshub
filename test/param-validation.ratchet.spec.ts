/**
 * Path-parameter validation ratchet — every id in a route must be validated before it
 * reaches the database.
 *
 * Why this exists: 49 of 62 `@Param()` sites had no pipe, and each one was a reachable 500.
 * A malformed id went straight into a query and came back as
 * `invalid input syntax for type uuid`, which the filter surfaced as
 * `INTERNAL_ERROR` — an unhandled server fault any authenticated caller could trigger with
 * a typo, and noise that buries real errors in the log. Found by driving the API by hand;
 * no test could see it, because no test sent a bad id.
 *
 * This is an ALLOWLIST, not a count. A count tells you the number went up; an allowlist
 * makes whoever adds a route say out loud that their parameter is not an id, which is the
 * only judgement a reviewer actually needs to check.
 *
 * ParseUUIDPipe accepts uuidv7 — verified against a live route before adopting it, since
 * every id opshub mints is v7 (`newId()`). Do not "fix" a v7 rejection that is not happening.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// `__dirname`, matching the other ratchets: this project's tsconfig module setting
// rejects `import.meta`, and vitest transpiles it away so only `tsc -b` sees the error.
const ROOT = join(__dirname, '..');

/**
 * Parameters that are legitimately NOT uuids, and must therefore NOT carry ParseUUIDPipe.
 *
 * Keyed by `<file>:<param>` so adding an unrelated string param to a file that already has
 * one still has to be declared. Add an entry only for a parameter that genuinely is not an
 * id — never to quiet a real finding.
 */
const NON_UUID_PARAMS = new Set<string>([
  // Notification type key, e.g. `request.submitted` — a catalogue string, not a row id.
  'notification-preferences.controller.ts:type',
]);

function controllerFiles(): string[] {
  return (
    execFileSync('git', ['ls-files', '*.controller.ts'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
      // `git ls-files` reports the INDEX, so a file deleted but not yet staged would throw
      // ENOENT here and kill the check with an error that looks nothing like a param problem.
      .filter((f) => existsSync(join(ROOT, f)))
  );
}

describe('path parameters are validated before they reach the database', () => {
  it('finds the controller surface it claims to guard', () => {
    // A scanner that stops seeing controllers reports zero violations, which is
    // indistinguishable from a clean codebase.
    expect(
      controllerFiles().length,
      'Found almost no controllers. The scanner is broken, not the routes.',
    ).toBeGreaterThanOrEqual(10);
  });

  it('has no @Param() without ParseUUIDPipe outside the declared allowlist', () => {
    const offenders: string[] = [];

    for (const file of controllerFiles()) {
      const source = readFileSync(join(ROOT, file), 'utf8');
      const base = file.split('/').pop()!;
      // Matches `@Param('name')` and `@Param('name', SomePipe)` alike, so the pipe's
      // presence is decided by the captured group rather than by the regex.
      for (const m of source.matchAll(/@Param\('([a-zA-Z]+)'\s*(,\s*[^)]+)?\)/g)) {
        const [, name, pipe] = m;
        if (pipe?.includes('ParseUUIDPipe')) continue;
        if (NON_UUID_PARAMS.has(`${base}:${name}`)) continue;
        offenders.push(`${file}: @Param('${name}')`);
      }
    }

    expect(
      offenders,
      `These path parameters reach the database unvalidated, so a malformed id is a 500 ` +
        `rather than a 400:\n  ${offenders.join('\n  ')}\n\n` +
        `Add ParseUUIDPipe, or declare the parameter in NON_UUID_PARAMS if it genuinely ` +
        `is not an id.`,
    ).toEqual([]);
  });
});
