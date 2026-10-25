import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// The bridge turns the ECS-injected GRAPH_CLIENT_CERTIFICATE env value into the
// worker-only file platform-mail reads (AZURE_CLIENT_CERTIFICATE_PATH). It is
// the ECS half of the ONPREM-PLAN §7.3 "file, never a PEM env value" rule:
// ECS secrets arrive as env values, and the app must not read a PEM from env.
const script = join(process.cwd(), 'docker/graph-cert-bridge.sh');

let dir: string;

// Env assignments go INSIDE the sh -c string: spawn-env options proved
// unreliable across runners, and assignments are POSIX-exact everywhere.
const run = (
  extraEnv: Record<string, string>,
  cmd = 'node -e "console.log(process.env.AZURE_CLIENT_CERTIFICATE_PATH ?? \'\')"',
) => {
  const assignments = Object.entries({ GRAPH_CERT_FILE: join(dir, 'cert.pem'), ...extraEnv })
    .map(([k, v]) => `${k}='${v}'`)
    .join(' ');
  return execFileSync('/bin/sh', ['-c', `${assignments} "${script}" ${cmd}`], { encoding: 'utf8' });
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'graph-cert-bridge-'));
});

// Every test makes its own temp dir; clean each one up as it is done with it.
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('docker/graph-cert-bridge.sh', () => {
  it('writes the injected PEM to a worker-only file and exports its path', () => {
    const out = run({ GRAPH_CLIENT_CERTIFICATE: '-----BEGIN TEST KEY-----' }).trim();
    expect(out).toBe(join(dir, 'cert.pem'));
    const pem = readFileSync(join(dir, 'cert.pem'), 'utf8');
    expect(pem).toBe('-----BEGIN TEST KEY-----\n');
    // Worker-only: the materialized file must not be group/world readable.
    const mode = statSync(join(dir, 'cert.pem')).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('keeps a preset AZURE_CLIENT_CERTIFICATE_PATH (k3s mount wins, no file written)', () => {
    const out = run({
      GRAPH_CLIENT_CERTIFICATE: '-----BEGIN TEST KEY-----',
      AZURE_CLIENT_CERTIFICATE_PATH: '/mnt/secrets/preset.pem',
    }).trim();
    expect(out).toBe('/mnt/secrets/preset.pem');
    expect(() => statSync(join(dir, 'cert.pem'))).toThrow();
  });

  it('does nothing without an injected PEM (API container, or provider not graph)', () => {
    const out = run({}).trim();
    expect(out).toBe('');
    expect(() => statSync(join(dir, 'cert.pem'))).toThrow();
  });

  it('runs the wrapped command unchanged', () => {
    const out = run(
      { GRAPH_CLIENT_CERTIFICATE: '-----BEGIN TEST KEY-----' },
      'node -e "console.log(\'boot\')"',
    ).trim();
    expect(out).toBe('boot');
  });

  it('unsets the injected PEM before exec: the wrapped command must not see it (§7.3)', () => {
    const out = run(
      { GRAPH_CLIENT_CERTIFICATE: '-----BEGIN TEST KEY-----' },
      'node -e "console.log(process.env.GRAPH_CLIENT_CERTIFICATE ?? \'unset\')"',
    ).trim();
    expect(out).toBe('unset');
  });
});
