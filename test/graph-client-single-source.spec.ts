/// <reference types="node" />
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Microsoft Graph lives in the worker, and in one place.
 *
 * THE RULES, each a test below:
 *   1. One factory builds the client and its credential (`libs/modules/graph`). A client built per call
 *      throws away the credential's token cache — a client-credentials round trip to Entra per
 *      operation, and Entra throttles that endpoint.
 *   2. Only that module reads GRAPH_* configuration, so there is one answer to "is Graph on".
 *   3. THE API CANNOT REACH GRAPH. Nothing under `apps/api` imports the Graph module, and nothing
 *      outside the module injects `GraphClientService`: an API request that needs Graph writes a
 *      `graph_task_outbox` row through `GraphTaskQueue` and the worker performs it. The API task is not
 *      given any GRAPH_* variable, so a compromised API process has no Graph credential to steal.
 *   4. The barrel (`@modules/graph`) the API may import does not export the client or the module.
 *   5. No source file asks for the Entra directory role-management permission. The PIM client that did
 *      had no caller and would have put a tenant-takeover permission on an unattended app.
 *
 * WHY A RATCHET. The next Graph integration is written by copying the nearest one, which is how five
 * copies of `buildClient()` happened. This fails the moment a sixth, or an API-side call, appears.
 *
 * __dirname, not import.meta.dirname: this suite runs as CommonJS.
 */

const ROOT = join(__dirname, '..');

const MODULE_DIR = 'libs/modules/graph/';
/** The two files allowed to construct a client and a credential. */
const OWNERS = [
  'libs/modules/graph/src/graph-client.service.ts',
  'libs/modules/graph/src/graph-credential.ts',
];
const OWNER = OWNERS[0];

/** Constructing the client, or the credential it wraps, or naming the scope. */
const BUILDS_CLIENT =
  /Client\.initWithMiddleware|new (ClientSecret|ClientCertificate|WorkloadIdentity|ClientAssertion)Credential|graph\.microsoft\.com\/\.default/;

/** The env vars that make up the answer, read directly rather than asked for. */
const READS_GRAPH_CONFIG = /config\.get\('GRAPH_[A-Z_]+'\)/;

interface Offender {
  file: string;
  line: number;
  text: string;
}

function sourceFiles(): string[] {
  return (
    execFileSync(
      'git',
      // `--others --exclude-standard` too: a NEW integration service is the likeliest sixth copy, and a
      // bare `git ls-files` cannot see one until it is staged.
      ['ls-files', '--cached', '--others', '--exclude-standard', 'libs', 'apps'],
      { cwd: ROOT, encoding: 'utf8' },
    )
      .split('\n')
      .filter(Boolean)
      .filter((f) => f.endsWith('.ts'))
      .filter((f) => !/\.(spec|e2e)\.ts$/.test(f))
      .filter((f) => !f.includes('/generated/'))
      // The index lists a file deleted but not yet staged; reading it would throw and take this down.
      .filter((f) => existsSync(join(ROOT, f)))
  );
}

interface ScanOptions {
  /** Files to look at; default all. */
  only?: (file: string) => boolean;
  /** Files exempt from this rule; default none. */
  except?: (file: string) => boolean;
}

function scan(pattern: RegExp, { only, except }: ScanOptions = {}): Offender[] {
  const offenders: Offender[] = [];
  for (const file of sourceFiles()) {
    if (only && !only(file)) continue;
    if (except?.(file)) continue;
    readFileSync(join(ROOT, file), 'utf8')
      .split('\n')
      .forEach((line, index) => {
        // Prose about the rule is not a violation of it — this file's own docblock would count itself.
        if (/^\s*(\*|\/\/)/.test(line)) return;
        if (pattern.test(line)) {
          offenders.push({ file, line: index + 1, text: line.trim().slice(0, 120) });
        }
      });
  }
  return offenders;
}

function report(offenders: Offender[]): string {
  return offenders.map((o) => `  ${o.file}:${o.line}\n      ${o.text}`).join('\n');
}

const inModule = (f: string) => f.startsWith(MODULE_DIR);

describe('Graph lives in the worker, in one place', () => {
  it('finds the factory it claims to guard', () => {
    /*
     * The floor. A check on an ABSENT pattern passes trivially when the thing it protects is gone:
     * if the factory were deleted, every consumer would fail to compile, but this file would go
     * green. So the floor is the factory's existence, that it still builds a client, that it still
     * caches one, and that its consumers still ask it.
     */
    const files = sourceFiles();
    expect(files.length, 'the scanner sees almost no source files').toBeGreaterThan(100);
    for (const owner of OWNERS) expect(files, `${owner} is gone`).toContain(owner);

    const owner = readFileSync(join(ROOT, OWNER), 'utf8');
    expect(owner).toMatch(/Client\.initWithMiddleware/);
    expect(owner, 'the factory no longer caches the client').toMatch(/this\.cached/);

    const consumers = files.filter(
      (f) => f !== OWNER && /GraphClientService/.test(readFileSync(join(ROOT, f), 'utf8')),
    );
    expect(
      consumers.length,
      'nothing injects the Graph factory — the checks below prove nothing',
    ).toBeGreaterThanOrEqual(5);
  });

  it('has no second place building a Graph client or credential', () => {
    const offenders = scan(BUILDS_CLIENT, { except: (f) => OWNERS.includes(f) });
    expect(
      offenders,
      `place(s) building a Graph client outside ${OWNERS.join(' / ')}:\n${report(offenders)}`,
    ).toEqual([]);
  });

  it('has no second answer to whether Graph is configured', () => {
    // `isEnabled()` gates every Graph path, so two implementations of it can disagree about whether the
    // integration is on — and the failure mode is a silent skip, which reports success.
    const offenders = scan(READS_GRAPH_CONFIG, { except: inModule });
    expect(
      offenders,
      `place(s) reading GRAPH_* config outside ${MODULE_DIR}:\n${report(offenders)}`,
    ).toEqual([]);
  });

  it('keeps Graph out of the API: only the worker imports the Graph module or injects the client', () => {
    const importsModule = scan(/\bGraphModule\b|modules\/graph\/graph\.module/, {
      except: (f) => inModule(f) || f.startsWith('apps/worker/'),
    });
    expect(
      importsModule,
      `The Graph module is worker-only — the API asks via GraphTaskQueue:\n${report(importsModule)}`,
    ).toEqual([]);

    const injectsClient = scan(/\bGraphClientService\b/, { except: inModule });
    expect(
      injectsClient,
      `Only libs/modules/graph may use GraphClientService:\n${report(injectsClient)}`,
    ).toEqual([]);
  });

  it('exports nothing from the barrel that could reach Graph', () => {
    const barrel = readFileSync(join(ROOT, MODULE_DIR, 'src/index.ts'), 'utf8')
      .split('\n')
      .filter((line) => !/^\s*\/\//.test(line))
      .join('\n');
    expect(barrel).not.toMatch(/GraphClientService|GraphModule\b|graph\.module|graph-client/);
    expect(barrel).toMatch(/GraphTaskQueue/);
  });

  it('asks for no Entra directory role-management permission or endpoint', () => {
    const offenders = scan(/roleManagement|RoleManagement/);
    expect(
      offenders,
      `Tier-0 permission/endpoint referenced — the Graph worker app must not hold it:\n${report(offenders)}`,
    ).toEqual([]);
  });
});
