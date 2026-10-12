import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Ratchet: every HTTP route handler must DECLARE how it is authorized. Baseline 0.
 *
 * This used to be a debt counter at 43, because `PolicyGuard` returned `true` on missing
 * metadata: a handler nobody decorated was allowed, to any authenticated caller. `SessionAuthGuard`
 * proved *who* you were and nothing then checked *whether you may*, so forgetting a decorator
 * was not a 500 and not a 403 — it was a silently world-readable endpoint that every test
 * still passed.
 *
 * The guard now denies an undeclared route, and `assertEveryRouteDeclaresAuthz` refuses to
 * finish bootstrapping when one exists. So this is no longer a debt marker: it is a static
 * fast check for a property the runtime also enforces, and it stays because a source-text scan
 * runs in milliseconds and names the file and line, while the boot audit needs a module graph.
 *
 * FIVE declarations satisfy it, and every route has exactly one:
 *   `@RequirePermission(code, scope?)`   a permission, resolved from the database
 *   `@Public()`                          no principal exists yet (probes, HMAC webhook)
 *   `@SelfScoped(reason)`                the subject IS the caller
 *   `@AuthorizedInService(reason, test)` resolved at run time, pinned by a named test
 *   `@AuthzGap(reason)`                  a KNOWN missing check, counted below
 *
 * `@Auth()` is NOT one of them. It mounts SessionAuthGuard and nothing else, so treating it as
 * authorization would make this ratchet report zero while changing nothing about who may call
 * what — which is exactly the state that produced the 43.
 *
 * This scanner reads SOURCE TEXT. It cannot tell a correct permission code from a misspelled
 * one, and it cannot see authorization that lives inside a service — `@AuthorizedInService`
 * routes satisfy it by declaring, not by being checked here. That is why a ratchet is a smoke
 * detector and the e2e and unit suites are the authorization tests.
 */

// ── Baseline — LOWER as routes get decorated, NEVER raise ─────────────────────
//
// 46 when the scanner was written; 43 after the three `employees/:id/avatar/*` routes were
// decorated. Note what did NOT move it: the six workforce routes fixed in the same change
// are still counted, because their authorization lives in the service (bucket 3). A
// falling count is evidence of decorators added, never of authorization added.
//
// Raising this number is forbidden. If you are here because your change made the count
// rise, the fix is to decorate the route, not to edit this line. The ONE shape that could
// justify a rise is authorization MOVING INTO A SERVICE because no decorator can express
// it — and then the move must be pinned by a test asserting BOTH directions, and named in
// the docblock above.
//
// This baseline is a DEBT MARKER, not a target: it exists so the unpoliced surface stops
// growing while the remaining routes are closed one module at a time.
const MAX_UNPOLICED_ROUTES = 0;

/**
 * Routes carrying `@AuthzGap` — a DECLARED missing check. MAY ONLY FALL, and is now 0.
 *
 * It was 6 for one commit: the request engine and the access-request module built their WHERE
 * from optional filters, so an unfiltered call returned every row, and their by-id reads had no
 * ownership check at all. Declaring them was how they stopped being invisible among 43
 * undecorated routes; `request.read` and `ActorScope` are how they were closed.
 *
 * At 0 this is the real assertion: `@AuthzGap` exists, so a future known hole can be shipped
 * deliberately, but doing so has to raise this number in review rather than pass silently.
 */
const MAX_AUTHZ_GAPS = 0;

/** Sanity floor: if the scanner stops finding routes, fail loudly, not silently. */
const MIN_ROUTES_FOUND = 100;

const ROOT = join(__dirname, '..');
const HTTP_METHOD = /^\s*@(Get|Post|Patch|Put|Delete)\(/;
const DECORATOR = /^\s*@\w+\(/;
const HANDLER = /^\s*(?:async\s+)?[\w[\]'"]+\s*\(/;
/**
 * Anchored to the start of the line (modulo indent) so it matches a real decorator and
 * not prose: an unanchored /@RequirePermission/ also matches the doc comments that
 * mention the decorator by name, which would silently mark whole controllers as policed.
 */
const POLICY =
  /^\s*@(RequirePermission|Public|SelfScoped|SharedRead|AuthorizedInService|AuthzGap)\b/;
const COMMENT = /^\s*(\/\/|\/?\*)/;

interface Route {
  file: string;
  line: number;
  signature: string;
}

function scanRoutes(): { all: Route[]; unpoliced: Route[] } {
  const files = execFileSync('git', ['ls-files', '*.controller.ts'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean)
    // See the note in query-ordering.ratchet.spec.ts: a tracked path is not necessarily a
    // path on disk, and reading a missing one crashes the ratchet instead of reporting.
    .filter((f) => existsSync(join(ROOT, f)));

  const all: Route[] = [];
  const unpoliced: Route[] = [];

  for (const file of files) {
    const lines = readFileSync(join(ROOT, file), 'utf8').split('\n');

    // A class-level @RequirePermission or @Public covers every handler in the file
    // (Reflector.getAllAndOverride reads handler THEN class), so honour it rather than
    // reporting every route in that controller as a false positive.
    const classDeclaration = lines.findIndex((l) => /^export class/.test(l));
    const classPolicied =
      classDeclaration > 0 &&
      lines.slice(0, classDeclaration).some((l) => !COMMENT.test(l) && POLICY.test(l));

    for (let i = 0; i < lines.length; i++) {
      if (!HTTP_METHOD.test(lines[i])) continue;

      // Everything between the HTTP verb and the handler signature is this route's
      // decorator block.
      const decorators: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        if (COMMENT.test(lines[j])) continue;
        if (DECORATOR.test(lines[j])) decorators.push(lines[j]);
        else if (HANDLER.test(lines[j])) break;
      }

      const route = { file, line: i + 1, signature: lines[i].trim() };
      all.push(route);
      // Per line, not against the joined block: POLICY is `^`-anchored and has no `m`
      // flag, so testing the join would only ever match the FIRST decorator of a route.
      if (!classPolicied && !decorators.some((d) => POLICY.test(d))) unpoliced.push(route);
    }
  }

  return { all, unpoliced };
}

function report(routes: Route[]): string {
  const byFile = new Map<string, string[]>();
  for (const r of routes) {
    byFile.set(r.file, [...(byFile.get(r.file) ?? []), `${r.signature}  (line ${r.line})`]);
  }
  return [...byFile.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([file, rs]) => `  ${file}\n${rs.map((r) => `      ${r}`).join('\n')}`)
    .join('\n');
}

describe('route-policy ratchet (only ever decreases)', () => {
  it('finds the controller surface it claims to guard', () => {
    const { all } = scanRoutes();
    expect(
      all.length,
      'Found almost no route handlers. The scanner is broken, not the controllers.',
    ).toBeGreaterThanOrEqual(MIN_ROUTES_FOUND);
  });

  it(`route handlers with neither @RequirePermission nor @Public <= ${MAX_UNPOLICED_ROUTES}`, () => {
    const { unpoliced } = scanRoutes();

    if (unpoliced.length > MAX_UNPOLICED_ROUTES) {
      throw new Error(
        `Unpoliced routes rose to ${unpoliced.length} (baseline ${MAX_UNPOLICED_ROUTES}).\n` +
          `PolicyGuard ALLOWS a handler with no policy metadata, so a new route without ` +
          `@RequirePermission is open to every authenticated caller. Add the decorator — ` +
          `do not raise the baseline.\n\n${report(unpoliced)}`,
      );
    }

    expect(unpoliced.length).toBeLessThanOrEqual(MAX_UNPOLICED_ROUTES);
  });

  it(`declared authorization gaps <= ${MAX_AUTHZ_GAPS}`, () => {
    const files = execFileSync('git', ['ls-files', '*.controller.ts'], {
      cwd: ROOT,
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean)
      .filter((f) => existsSync(join(ROOT, f)));

    const gaps: string[] = [];
    for (const file of files) {
      const lines = readFileSync(join(ROOT, file), 'utf8').split('\n');
      lines.forEach((l, i) => {
        if (/^\s*@AuthzGap\(/.test(l)) gaps.push(`${file}:${i + 1}`);
      });
    }

    expect(
      gaps.length,
      `Declared authorization gaps rose to ${gaps.length} (max ${MAX_AUTHZ_GAPS}):\n  ` +
        `${gaps.join('\n  ')}\n\n@AuthzGap ships a KNOWN hole. Adding one is a decision to ` +
        `be argued in review, not a way to satisfy the boot audit.`,
    ).toBeLessThanOrEqual(MAX_AUTHZ_GAPS);

    expect(
      gaps.length,
      `MAX_AUTHZ_GAPS is ${MAX_AUTHZ_GAPS} but only ${gaps.length} remain — lower it, or the ` +
        `ratchet stops measuring.`,
    ).toBe(MAX_AUTHZ_GAPS);
  });

  /*
   * `@AuthorizedInService(reason, pinnedBy)` IS ONLY HONEST IF THE PINNED SPEC EXISTS.
   *
   * That decorator is the one escape from a declared route-level permission: it asserts the check
   * lives in the service and names the test that proves it. The decorator's own docblock says
   * `pinnedBy` "is required because this mode moves the check out of the declaration" — but nothing
   * read the value, so any string satisfied it, and a route could carry a citation as its proof
   * while the cited test did not exist. The sibling repo shipped exactly that: twelve routes citing
   * one spec file that was never written, which is how two access defects survived review.
   *
   * Both halves matter. A missing file makes the claim unfalsifiable. A file that exists but is not
   * a test makes it worse — it reads as verified while pointing at the implementation.
   */
  it('every @AuthorizedInService pins a spec that exists and is a test', () => {
    const tracked = new Set(
      execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
        cwd: ROOT,
        encoding: 'utf8',
      })
        .split('\n')
        .filter(Boolean),
    );
    const basenames = new Map<string, string[]>();
    for (const file of tracked) {
      const base = file.split('/').pop()!;
      basenames.set(base, [...(basenames.get(base) ?? []), file]);
    }

    const files = execFileSync('git', ['ls-files', '*.controller.ts'], {
      cwd: ROOT,
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean)
      .filter((f) => existsSync(join(ROOT, f)));

    const missing: string[] = [];
    const notATest: string[] = [];
    let citations = 0;

    for (const file of files) {
      const source = readFileSync(join(ROOT, file), 'utf8');
      // The second argument, across the line break prettier puts it on.
      for (const m of source.matchAll(
        /@AuthorizedInService\(\s*(?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")\s*,\s*'([^']+)'/g,
      )) {
        citations += 1;
        const cited = m[1];
        const hits = basenames.get(cited.split('/').pop()!) ?? [];
        if (hits.length === 0) missing.push(`${file} cites ${cited}`);
        else if (!hits.some((h) => /\.(spec|e2e)\.tsx?$/.test(h))) {
          notATest.push(`${file} cites ${cited} (${hits.join(', ')})`);
        }
      }
    }

    // Floor first: the decorator is in use, so a regex that matched nothing would report perfect
    // citations for zero routes — the exact way this kind of check passes for the wrong reason.
    expect(
      citations,
      'found no @AuthorizedInService citations to check — the regex is broken',
    ).toBeGreaterThan(5);

    expect(
      missing,
      'These routes moved their authorization into a service and cited a test that does not ' +
        'exist, so the claim cannot be checked by anybody:\n  ' +
        missing.join('\n  '),
    ).toEqual([]);
    expect(
      notATest,
      'These citations name a file that is not a test:\n  ' + notATest.join('\n  '),
    ).toEqual([]);
  });
});
