/**
 * Every presign and confirm route carries the UPLOAD rate-limit tier. A floor, not a count.
 *
 * A presign hands out a signed S3 PUT and a confirm issues a HeadObject, so both cost object-storage
 * requests rather than database time — which is exactly why `RATE_LIMIT_TIERS.UPLOAD` exists (30/min per
 * user, against the 600/min DEFAULT). Assets carried it from the start. Employee avatars, leave documents
 * and training certificates did not: the tier existed and two thirds of the product's uploads ignored it,
 * which is the kind of gap nothing notices because the endpoints still work — they are just billed at the
 * wrong tier and unprotected against a loop.
 *
 * Scans the ROUTE DECORATORS, not a count of files, so a new upload surface has to say `@RateLimit`
 * out loud. `@Get(':id/certificates/:fileId/download')` is deliberately not in scope: a download is a
 * presigned GET, cheap, and lives on read paths a UI hits per row.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');

/** A route decorator line, e.g. `@Post(':id/avatar/presign')`. */
const ROUTE_LINE = /@(Post|Put|Patch)\(\s*['"]([^'"]*)['"]/;

function controllerFiles(): string[] {
  return execFileSync('git', ['ls-files', '*.controller.ts'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .filter((f) => existsSync(join(ROOT, f)));
}

describe('upload routes are rate-limited at the UPLOAD tier', () => {
  it('finds the controller surface it claims to guard', () => {
    expect(
      controllerFiles().length,
      'Found almost no controllers. The scanner is broken, not the routes.',
    ).toBeGreaterThanOrEqual(10);
  });

  it('has no presign or confirm route without @RateLimit(UPLOAD)', () => {
    const offenders: string[] = [];

    for (const file of controllerFiles()) {
      const lines = readFileSync(join(ROOT, file), 'utf8').split('\n');
      lines.forEach((line, index) => {
        const match = ROUTE_LINE.exec(line);
        if (!match) return;
        const path = match[2];
        if (!/presign|confirm/.test(path)) return;

        // The decorators for one handler sit together; look at the block around this line rather than
        // the whole file, so one decorated route cannot vouch for an undecorated neighbour.
        const block = lines.slice(Math.max(0, index - 12), index + 12).join('\n');
        if (!block.includes("@RateLimit('UPLOAD')")) {
          offenders.push(`${file}:${index + 1} — ${path}`);
        }
      });
    }

    if (offenders.length > 0) {
      throw new Error(
        `Upload routes must carry @RateLimit('UPLOAD') — a presign or confirm costs S3 requests:\n` +
          offenders.map((o) => `  ${o}`).join('\n'),
      );
    }
    expect(offenders).toHaveLength(0);
  });

  it('finds the routes it is supposed to be checking', () => {
    // A regex that stops matching route decorators would report a clean codebase. Four surfaces upload
    // today (avatar, asset photo, leave document, training certificate) — two routes each.
    let found = 0;
    for (const file of controllerFiles()) {
      for (const line of readFileSync(join(ROOT, file), 'utf8').split('\n')) {
        const match = ROUTE_LINE.exec(line);
        if (match && /presign|confirm/.test(match[2])) found += 1;
      }
    }
    expect(found, 'the scanner matched no upload routes at all').toBeGreaterThanOrEqual(8);
  });
});
