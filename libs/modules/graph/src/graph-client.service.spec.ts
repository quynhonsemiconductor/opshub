/**
 * The shared Graph client, and the three promises it makes.
 *
 * 1. ONE client. Both credentials cache their access token in the instance, so a client per call is a
 *    client-credentials round trip to Entra per operation, and Entra throttles that endpoint. The
 *    assertion is identity (`toBe`), not equality.
 * 2. OFF IS QUIET. No GRAPH_CLIENT_ID means no Graph, and the whole process says so exactly once.
 * 3. NO SECRET. The credential is a certificate (ECS, now) or a projected ServiceAccount token (k3s,
 *    later); the federated one wins, so the cut-over is adding a variable.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const identity = vi.hoisted(() => ({
  ClientCertificateCredential: vi.fn(),
  WorkloadIdentityCredential: vi.fn(),
}));
vi.mock('@azure/identity', () => identity);

import { GraphClientService } from './graph-client.service';
import { graphCredentialKind } from './graph-credential';

type Env = Partial<
  Record<
    | 'ENTRA_TENANT_ID'
    | 'GRAPH_CLIENT_ID'
    | 'GRAPH_CLIENT_CERTIFICATE'
    | 'GRAPH_FEDERATED_TOKEN_FILE',
    string
  >
>;

function makeService(env: Env) {
  const config = { get: vi.fn((key: keyof Env) => env[key]) };
  const service = new GraphClientService(config as never);
  const log = vi.spyOn(
    (service as unknown as { logger: { log: (m: string) => void } }).logger,
    'log',
  );
  return { service, config, log };
}

const PEM = '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----';
const CERT: Env = {
  ENTRA_TENANT_ID: 'tenant-1',
  GRAPH_CLIENT_ID: 'graph-app',
  GRAPH_CLIENT_CERTIFICATE: PEM,
};
const FEDERATED: Env = {
  ENTRA_TENANT_ID: 'tenant-1',
  GRAPH_CLIENT_ID: 'graph-app',
  GRAPH_FEDERATED_TOKEN_FILE: '/var/run/secrets/tokens/graph',
};

beforeEach(() => {
  identity.ClientCertificateCredential.mockReset().mockImplementation(function () {
    return { getToken: vi.fn() };
  });
  identity.WorkloadIdentityCredential.mockReset().mockImplementation(function () {
    return { getToken: vi.fn() };
  });
});

describe('GraphClientService', () => {
  it('builds the client once and hands back the same one', () => {
    const { service } = makeService(CERT);

    const first = service.client();

    expect(service.client()).toBe(first);
    expect(identity.ClientCertificateCredential).toHaveBeenCalledTimes(1);
  });

  it('authenticates as the GRAPH app with a certificate — never with ENTRA_CLIENT_ID or a secret', () => {
    makeService(CERT).service.client();

    expect(identity.ClientCertificateCredential).toHaveBeenCalledWith('tenant-1', 'graph-app', {
      certificate: PEM,
    });
    expect(identity.WorkloadIdentityCredential).not.toHaveBeenCalled();
  });

  it('uses the federated token file when it is set, and that wins over a certificate', () => {
    makeService({ ...CERT, ...FEDERATED }).service.client();

    expect(identity.WorkloadIdentityCredential).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      clientId: 'graph-app',
      tokenFilePath: '/var/run/secrets/tokens/graph',
    });
    expect(identity.ClientCertificateCredential).not.toHaveBeenCalled();
  });

  it('refuses in words when Graph is not configured', () => {
    const { service } = makeService({});

    expect(() => service.client()).toThrow(/GRAPH_CLIENT_ID/);
  });

  it.each([
    ['nothing set', {}, undefined],
    [
      'no GRAPH_CLIENT_ID (the switch)',
      { ENTRA_TENANT_ID: 't', GRAPH_CLIENT_CERTIFICATE: PEM },
      undefined,
    ],
    ['no credential', { ENTRA_TENANT_ID: 't', GRAPH_CLIENT_ID: 'c' }, undefined],
    ['no tenant', { GRAPH_CLIENT_ID: 'c', GRAPH_CLIENT_CERTIFICATE: PEM }, undefined],
    ['certificate', CERT, 'certificate'],
    ['federated', FEDERATED, 'federated'],
  ] as const)('credential kind: %s', (_name, env, expected) => {
    expect(
      graphCredentialKind({
        tenantId: (env as Env).ENTRA_TENANT_ID,
        clientId: (env as Env).GRAPH_CLIENT_ID,
        certificatePem: (env as Env).GRAPH_CLIENT_CERTIFICATE,
        federatedTokenFile: (env as Env).GRAPH_FEDERATED_TOKEN_FILE,
      }),
    ).toBe(expected);
  });

  it('says it is off exactly once, however many features ask', () => {
    const { service, log } = makeService({});

    for (let i = 0; i < 5; i++) expect(service.isEnabled()).toBe(false);

    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatch(/Graph is off/);
  });

  it('says nothing when it is on', () => {
    const { service, log } = makeService(CERT);

    expect(service.isEnabled()).toBe(true);
    expect(log).not.toHaveBeenCalled();
  });
});
