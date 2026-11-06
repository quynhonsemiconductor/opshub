import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * THE MCP RATCHET (MCP-PLAN §4). The HTTP layer is the authorization point: every tool call must
 * cross the same guards (`PolicyGuard` and friends) as the person's own session, which is why a
 * tool composes REST routes through in-process `inject()` and nothing else. A tool that imported
 * a controller, service, repository or DB client directly would skip all of it, and a tool that
 * touched a header or the raw request would make the principal forgeable. This spec fails any
 * such change under `apps/api/src/mcp/tools/`.
 *
 * Guards the SHAPE, not a count (route counts drift; this does not). It checks imports and
 * comment-stripped source, so the prose above can keep explaining why these rules exist.
 */

const TOOLS_DIR = __dirname; // this spec lives IN the directory it ratchets

function toolFiles(): string[] {
  return readdirSync(TOOLS_DIR)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'))
    .map((f) => join(TOOLS_DIR, f));
}

/** Line comments, block comments — enough for these mechanical checks. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/**
 * Every module reference in a tool file, from the SYNTAX TREE (a regex misses double quotes,
 * `require()`, dynamic `import()` and side-effect imports — all of which load code): static
 * imports and re-exports, side-effect imports, `require('…')` and `await import('…')`.
 */
function moduleReferences(src: string): string[] {
  const refs: string[] = [];
  const walk = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || (ts.isExportDeclaration(node) && node.moduleSpecifier)) {
      const spec = node.moduleSpecifier;
      if (spec && ts.isStringLiteral(spec)) refs.push(spec.text);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.RequireKeyword ||
        node.expression.kind === ts.SyntaxKind.ImportKeyword) &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      refs.push(node.arguments[0].text);
    }
    ts.forEachChild(node, walk);
  };
  walk(ts.createSourceFile('tool.ts', src, ts.ScriptTarget.Latest, true));
  return refs;
}

/**
 * The ONLY things a tool file may reference as a module: the MCP SDK, zod, the ONE platform
 * primitive the bridge runs on, and this module's own plumbing (rest caller, sibling tools,
 * registry). Anything else — a controller, an application service, `@modules/*`, drizzle, the DB
 * schema — is a layer skip.
 *
 * Deliberately NOT the `@platform` barrel (it re-exports the DB, storage, email and outbox) and
 * NOT `node:*` (a tool has no legitimate filesystem, network or process need). The single named
 * import tools may take is the principal's TYPE.
 */
const ALLOWED_IMPORTS = [
  /^@modelcontextprotocol\//,
  /^zod$/,
  /^@platform\/mcp-call-token$/,
  /^\.\/[^/]*$/,
];

describe('MCP tools ratchet', () => {
  it('every tool file references only allowed modules (imports, require, dynamic import)', () => {
    const files = toolFiles();
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const offenders = moduleReferences(readFileSync(file, 'utf8')).filter(
        (spec) => !ALLOWED_IMPORTS.some((re) => re.test(spec)),
      );
      expect(offenders, `${file} references modules outside the allowlist`).toEqual([]);
    }
  });

  it('no tool file touches the raw request, a network header, or inject() headers', () => {
    for (const file of toolFiles()) {
      const src = stripComments(readFileSync(file, 'utf8'));
      // The principal travels in the MCP call token, never in a copied header.
      expect(src.match(/\bheaders\s*:/), file).toBeNull();
      expect(src.match(/\.(raw|headers)\b/), file).toBeNull();
      expect(src.match(/Cf-Access-Jwt-Assertion/i), file).toBeNull();
    }
  });

  it('every list tool declares a limit and a cursor (agent-sized pages, MCP-PLAN §11)', () => {
    for (const file of toolFiles()) {
      const src = stripComments(readFileSync(file, 'utf8'));
      if (!src.includes('pageArgs') && !src.match(/\bcursor\b/)) continue;
      expect(src.match(/\bcursor\b/), `${file}: no cursor`).not.toBeNull();
      expect(src.match(/\blimit\b/), `${file}: no limit`).not.toBeNull();
    }
  });

  it('no tool takes an employeeId as the CALLER: the principal is resolved once, by the adapter', () => {
    for (const file of toolFiles()) {
      const src = stripComments(readFileSync(file, 'utf8'));
      // A tool may name a TARGET employee (`get_employee`), never the acting one. The caller is
      // `ToolContext.principal`, minted from the Access JWT, and no argument can reach it.
      expect(
        src.match(/(actor|caller|acting|onBehalfOf|asEmployee|user)(Id|UserId|EmployeeId)?\s*:/i),
        `${file}: a tool must not take the acting employee as an argument`,
      ).toBeNull();
    }
  });
});
