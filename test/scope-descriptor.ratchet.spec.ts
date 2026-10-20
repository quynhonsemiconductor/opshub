/// <reference types="node" />
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A route that acts on ONE ROW should say which row, so a constrained grant can be evaluated.
 *
 * `@RequirePermission('asset.write', { resource: 'asset', from: 'param', field: 'id' })` is the full
 * form. The descriptor is what lets `ResourceScopeResolver` load the row and hand `ScopeEvaluator` an
 * owner, a team and a department to compare a `self`/`team`/`dept`/`region` grant against.
 *
 * WHAT THE GAP ACTUALLY IS, because it is the opposite of what it looks like. `AuthzService.check`
 * FAILS CLOSED: a holder whose grant is constrained, on a route that declares no scope, is DENIED and
 * a warning is logged naming the missing descriptor. Its own docblock explains why — the code used to
 * `return true` there, so a grant recorded as "asset.write @ team=X" was enforced as global. So an
 * undescriptored route is not an escalation.
 *
 * It is the reverse: the scoped-grant feature is INERT on these routes. `scope_type` is a five-value
 * enum, `POST /authz/assignments` accepts and validates `scopeType` + `scopeId`, and the row is
 * stored — and then every route without a descriptor refuses that holder. An operator can grant
 * "asset.write @ dept=Engineering" through the supported API and watch it do nothing except produce
 * 403s.
 *
 * 154 of the 161 row-scoped routes are in that state, which is why this is a BASELINE and not a
 * requirement. Adding 154 descriptors is a per-route judgement about which resource and which field,
 * and some of these routes are global by nature — a `dept`-scoped `rbac.manage` is not a thing anyone
 * wants. The number is here so the gap is counted rather than invisible, and so it cannot grow while
 * the routes are closed a module at a time.
 *
 * WHY NOT THE SIBLING REPO'S FIX. Rova makes the descriptor a REQUIRED overload parameter, so
 * omitting it is a compile error rather than something a test notices. That works there because its
 * permissions are split by TIER — workspace-wide versus project-scoped — and the requirement attaches
 * to the project tier. opshub has no tier: the same `asset.write` gates `POST /assets` (no row exists
 * yet) and `POST /assets/:id/retire` (one row). A required parameter would have to be satisfiable on
 * a collection route, where there is nothing to point at. The type system cannot express "row-scoped"
 * here without first inventing the tier, so this counts instead.
 *
 * __dirname, not import.meta.dirname: this suite runs as CommonJS.
 */

const ROOT = join(__dirname, '..');

/**
 * Row-scoped routes that name no resource. MAY ONLY FALL.
 *
 * Lower it when you descriptor a route. If your change made this RISE, the fix is to add the
 * descriptor, not to edit this line — a new route acting on one row is exactly the case this is here
 * to stop accumulating.
 */
const MAX_UNSCOPED_ROW_ROUTES = 154;

/** Sanity floor: if the scanner stops finding routes, fail loudly rather than silently. */
const MIN_ROW_ROUTES_FOUND = 120;

const HTTP_METHOD = /^\s*@(Get|Post|Patch|Put|Delete)\('([^']*)'\)/;
/**
 * The captured group is the character after the permission literal. A comma means a second argument
 * — the scope descriptor — follows. Anchored to the line start so it matches a decorator and not the
 * many docblocks that name `@RequirePermission` in prose.
 */
const REQUIRE_PERMISSION = /^\s*@RequirePermission\('([a-z_.]+)'(,?)/;

interface RowRoute {
  file: string;
  line: number;
  permission: string;
  route: string;
  scoped: boolean;
}

function scanRowScopedRoutes(): RowRoute[] {
  const files = execFileSync('git', ['ls-files', '*.controller.ts'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean)
    // `git ls-files` reports the INDEX, which still lists a file deleted in the working tree but not
    // yet staged — readFileSync then throws ENOENT and the failure looks nothing like an
    // authorization problem. Same guard the route-policy and query-ordering ratchets carry.
    .filter((f) => existsSync(join(ROOT, f)));

  const found: RowRoute[] = [];

  for (const file of files) {
    const lines = readFileSync(join(ROOT, file), 'utf8').split('\n');

    lines.forEach((line, index) => {
      const http = HTTP_METHOD.exec(line);
      if (!http) return;

      const path = http[2];
      // No path parameter means no single row to scope to: `POST /assets` creates one, and there is
      // nothing for a descriptor to point at. Those routes are correctly unscoped and not counted.
      if (!path.includes(':')) return;

      // The permission decorator for THIS handler. Stop at the next HTTP decorator so a handler
      // without one cannot borrow its neighbour's.
      for (let j = index + 1; j < Math.min(index + 25, lines.length); j += 1) {
        if (HTTP_METHOD.test(lines[j])) break;
        const perm = REQUIRE_PERMISSION.exec(lines[j]);
        if (!perm) continue;
        found.push({
          file,
          line: j + 1,
          permission: perm[1],
          route: `@${http[1]}('${path}')`,
          scoped: perm[2] === ',',
        });
        break;
      }
    });
  }

  return found;
}

describe('scope descriptors', () => {
  it('finds the row-scoped route surface it claims to guard', () => {
    // Without this, a regex that matched nothing would report zero unscoped routes — a perfect score
    // for having measured nothing, which is how this class of test passes for the wrong reason.
    const routes = scanRowScopedRoutes();
    expect(routes.length).toBeGreaterThanOrEqual(MIN_ROW_ROUTES_FOUND);

    // And it must find some of BOTH kinds. All-scoped or all-unscoped both mean the second capture
    // group stopped working, and each would silently satisfy one of the assertions below.
    expect(
      routes.some((r) => r.scoped),
      'no descriptored route found — the regex is broken',
    ).toBe(true);
    expect(routes.some((r) => !r.scoped)).toBe(true);
  });

  it(`row-scoped routes with no resource descriptor <= ${MAX_UNSCOPED_ROW_ROUTES}`, () => {
    const unscoped = scanRowScopedRoutes().filter((r) => !r.scoped);

    expect(
      unscoped.length,
      `Row-scoped routes with no descriptor rose to ${unscoped.length} ` +
        `(baseline ${MAX_UNSCOPED_ROW_ROUTES}). A route acting on one row should name it, so a ` +
        `self/team/dept/region grant can be checked against that row rather than denied:\n  ` +
        unscoped
          .slice(-12)
          .map((r) => `${r.file}:${r.line} ${r.permission} ${r.route}`)
          .join('\n  '),
    ).toBeLessThanOrEqual(MAX_UNSCOPED_ROW_ROUTES);

    expect(
      unscoped.length,
      `MAX_UNSCOPED_ROW_ROUTES is ${MAX_UNSCOPED_ROW_ROUTES} but only ${unscoped.length} remain — ` +
        `lower it, or the ratchet stops measuring.`,
    ).toBe(MAX_UNSCOPED_ROW_ROUTES);
  });

  it('keeps every route of one sub-resource in agreement about binding the row', () => {
    /*
     * THE SHAPE THAT ACTUALLY BIT: not a route missing a descriptor, but a route missing one while
     * its SIBLINGS on the same resource had it. `DELETE /employees/:id/avatar` was undescriptored
     * next to a presign, a confirm and a read that all were, and both asset photo WRITES were
     * undescriptored next to the read that was. A constrained holder could read a photo and not
     * replace it, or presign an upload and not finish it — the same row and the same permission
     * answering differently depending on which end of the flow they were at.
     *
     * A count cannot catch that; only comparing a surface with itself can.
     */
    const routes = scanRowScopedRoutes();
    const surfaces = new Map<string, RowRoute[]>();

    for (const route of routes) {
      /*
       * Group by the SUB-RESOURCE after the id, not by the id itself.
       *
       * `:id/photo`, `:id/photo/presign` and `:id/photo/confirm` are one surface and must agree.
       * `:id` and `:id/retire` are not part of it — grouping on the id alone put every route in a
       * controller into one bucket, which reports a disagreement for any partially-descriptored
       * controller and so would fail permanently while 154 routes are still open.
       */
      const match = /:\w+\/([\w-]+)/.exec(route.route);
      if (!match) continue;
      const key = `${route.file} :id/${match[1]}`;
      surfaces.set(key, [...(surfaces.get(key) ?? []), route]);
    }

    const disagreeing = [...surfaces.entries()]
      .filter(([, group]) => group.some((r) => r.scoped) && group.some((r) => !r.scoped))
      .map(
        ([key, group]) =>
          `${key}\n      ` +
          group
            .map((r) => `${r.scoped ? 'scoped  ' : 'UNSCOPED'} ${r.route} :${r.line}`)
            .join('\n      '),
      );

    expect(
      disagreeing,
      'These routes act on the same resource through the same permission module, and disagree about ' +
        'whether to bind the row. Whichever answer is right, it is the same for all of them:\n  ' +
        disagreeing.join('\n  '),
    ).toEqual([]);
  });
});
