/// <reference types="node" />
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * Microsoft Graph lives in the worker, and in one place. Checked by IMPORT CLOSURE, not by grep.
 *
 * THE RULE. Nothing the API process can load may reach Graph: the API holds no Graph credential, so an
 * API request that needs Graph writes a `graph_task_outbox` row (`GraphTaskQueue`) and the worker
 * performs it. "Can load" is the transitive import closure of `apps/api/src/main.ts`, computed with the
 * TypeScript program itself — the same module resolution (path aliases, barrels, `export *`, dynamic
 * `import()`, type-only imports) the compiler uses. A text search for `GraphModule` cannot see an
 * `import { x } from '@modules/graph/graph-credential'`, a barrel re-export, or a package reached through
 * a third file; the closure sees all of them.
 *
 * WHAT MAY BE REACHABLE under `libs/modules/graph/src`: only the task queue (`graph-task*.ts`,
 * `graph-tasks.module.ts`) and the barrel (`index.ts`), which is written to export nothing else. And NO
 * file of `@azure/identity` or `@microsoft/microsoft-graph-client` may be reachable at all.
 *
 * PROVED, not asserted: the mutation tests below add a file to the API's closure that does each of the
 * things this exists to forbid, and require the check to fail.
 *
 * __dirname, not import.meta.dirname: this suite runs as CommonJS.
 */

const ROOT = resolve(__dirname, '..');
const API_MAIN = join(ROOT, 'apps/api/src/main.ts');
const WORKER_MAIN = join(ROOT, 'apps/worker/src/main.ts');
const MUTANT = join(ROOT, 'apps/api/src/__graph_mutant__.ts');

const GRAPH_DIR = `${join(ROOT, 'libs/modules/graph/src')}/`;
/** The only files under libs/modules/graph/src the API may load. */
const API_MAY_LOAD = /\/libs\/modules\/graph\/src\/(graph-task[^/]*\.ts|index\.ts)$/;
const FORBIDDEN_PACKAGE =
  /\/node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?(@azure\/identity|@microsoft\/microsoft-graph-client)\//;

const options = (() => {
  const configPath = join(ROOT, 'tsconfig.json');
  const read = ts.readConfigFile(configPath, (f) => ts.sys.readFile(f));
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(configPath));
  return {
    ...parsed.options,
    noEmit: true,
    // Resolution only: no ambient `types` packages as extra roots, and no checking of library files.
    types: [],
    skipLibCheck: true,
  } satisfies ts.CompilerOptions;
})();

function makeProgram(
  rootNames: string[],
  virtual: Record<string, string> = {},
  oldProgram?: ts.Program,
): ts.Program {
  const base = ts.createCompilerHost(options);
  // A host that serves `virtual` files over the real file system.
  const host: ts.CompilerHost = {
    ...base,
    fileExists: (f) => f in virtual || base.fileExists(f),
    readFile: (f) => virtual[f] ?? base.readFile(f),
    getSourceFile: (f, languageVersion, onError, shouldCreate) =>
      f in virtual
        ? ts.createSourceFile(f, virtual[f], languageVersion, true)
        : base.getSourceFile(f, languageVersion, onError, shouldCreate),
  };
  return ts.createProgram({ rootNames, options, host, oldProgram });
}

interface Violation {
  file: string;
  why: string;
}

/** Everything under libs/modules/graph the API process could load, and any Graph SDK file at all. */
function violationsIn(program: ts.Program): Violation[] {
  const out: Violation[] = [];
  for (const sf of program.getSourceFiles()) {
    const f = sf.fileName;
    if (f.startsWith(GRAPH_DIR) && !API_MAY_LOAD.test(f)) {
      out.push({ file: relative(ROOT, f), why: 'Graph module code reachable from the API' });
    } else if (FORBIDDEN_PACKAGE.test(f)) {
      out.push({
        file: f.replace(/^.*\/node_modules\//, ''),
        why: 'Graph SDK reachable from the API',
      });
    }
  }
  return out;
}

function report(violations: Violation[]): string {
  return violations.map((v) => `  ${v.file}  (${v.why})`).join('\n');
}

describe('Graph is unreachable from the API (import closure)', () => {
  let api: ts.Program;

  beforeAll(() => {
    api = makeProgram([API_MAIN]);
  }, 120_000);

  it("the closure is real: it sees the API's own code and the task queue it is allowed to load", () => {
    /*
     * The floor. A closure check passes trivially if the analysis loads nothing — a wrong path, a broken
     * alias — so it must demonstrably see the API's code and the one piece of the Graph module the API
     * IS allowed, through the same alias the real code uses.
     */
    const files = api.getSourceFiles().map((f) => f.fileName);
    expect(files.length, 'the closure is nearly empty').toBeGreaterThan(300);
    expect(files).toContain(join(ROOT, 'apps/api/src/app.module.ts'));
    expect(files, 'GraphTaskQueue is not reachable: the API cannot enqueue').toContain(
      join(ROOT, 'libs/modules/graph/src/graph-task.queue.ts'),
    );
  });

  it('nothing the API can load reaches the Graph client, credential, module or SDK', () => {
    const violations = violationsIn(api);
    expect(violations, `\n${report(violations)}\n`).toEqual([]);
  });

  it('is not vacuous for the worker: the worker closure DOES reach all of it', () => {
    const worker = makeProgram([WORKER_MAIN], {}, api);
    const files = worker.getSourceFiles().map((f) => f.fileName);
    for (const needle of [
      'libs/modules/graph/src/graph-client.service.ts',
      'libs/modules/graph/src/graph-credential.ts',
      'libs/modules/graph/src/graph.module.ts',
    ]) {
      expect(files, `the worker does not reach ${needle}`).toContain(join(ROOT, needle));
    }
    expect(
      files.some((f) => FORBIDDEN_PACKAGE.test(f)),
      'the worker does not reach the Graph SDK',
    ).toBe(true);
  }, 120_000);
});

describe('the closure check fails when an API file does what it forbids (mutation)', () => {
  const mutants: Array<[string, string]> = [
    [
      'importing buildGraphCredential',
      "import { buildGraphCredential } from '@modules/graph/graph-credential';\nexport const m = buildGraphCredential;\n",
    ],
    [
      'importing GraphClientService',
      "import { GraphClientService } from '@modules/graph/graph-client.service';\nexport const m = GraphClientService;\n",
    ],
    [
      'importing the Graph module',
      "import { GraphModule } from '@modules/graph/graph.module';\nexport const m = GraphModule;\n",
    ],
    [
      'importing the SDK client directly',
      "import { Client } from '@microsoft/microsoft-graph-client';\nexport const m = Client;\n",
    ],
    [
      'importing an Azure credential directly',
      "import { ClientCertificateCredential } from '@azure/identity';\nexport const m = ClientCertificateCredential;\n",
    ],
    [
      'reaching a Graph service through a barrel re-export',
      "export * from '@modules/graph/application/entra-account.service';\n",
    ],
  ];

  it.each(mutants)(
    '%s',
    (_name, source) => {
      const program = makeProgram([API_MAIN, MUTANT], { [MUTANT]: source });
      expect(violationsIn(program).length, 'the check did not notice').toBeGreaterThan(0);
    },
    120_000,
  );

  it("reading a GRAPH_* variable through the API's config does not even compile", () => {
    const source =
      "import { ApiConfigService } from '@platform';\n" +
      "export const m = (c: ApiConfigService) => c.get('GRAPH_CLIENT_ID');\n";
    const program = makeProgram([API_MAIN, MUTANT], { [MUTANT]: source });
    const diagnostics = ts.getPreEmitDiagnostics(program, program.getSourceFile(MUTANT));

    expect(diagnostics.length, 'ApiConfigService.get accepted a Graph variable').toBeGreaterThan(0);
  }, 120_000);

  it('control: a harmless API file leaves the closure clean', () => {
    const source =
      "import { Injectable } from '@nestjs/common';\n@Injectable()\nexport class Harmless {}\n";
    const program = makeProgram([API_MAIN, MUTANT], { [MUTANT]: source });
    expect(violationsIn(program)).toEqual([]);
  }, 120_000);
});

describe('no source asks for the Entra directory role-management permission or endpoint', () => {
  it('has no reference under libs/ or apps/', () => {
    const offenders: string[] = [];
    for (const sf of ts
      .createProgram({
        rootNames: [API_MAIN, WORKER_MAIN],
        options,
      })
      .getSourceFiles()) {
      if (sf.fileName.includes('/node_modules/')) continue;
      sf.text.split('\n').forEach((line, i) => {
        if (/^\s*(\*|\/\/)/.test(line)) return; // prose about the rule is not a violation of it
        if (/roleManagement|RoleManagement/.test(line)) {
          offenders.push(`${relative(ROOT, sf.fileName)}:${i + 1}`);
        }
      });
    }
    expect(
      offenders,
      'Tier-0 permission/endpoint referenced — the Graph worker app must not hold it',
    ).toEqual([]);
  }, 120_000);
});
