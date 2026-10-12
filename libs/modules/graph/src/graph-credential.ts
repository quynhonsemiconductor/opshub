import { ClientCertificateCredential, WorkloadIdentityCredential } from '@azure/identity';
import type { TokenCredential } from '@azure/identity';

/** What the Graph worker app is authenticated with. Never a client secret. */
export interface GraphCredentialConfig {
  tenantId: string | undefined;
  clientId: string | undefined;
  /** PEM with the private key and certificate (ECS, now). */
  certificatePem: string | undefined;
  /** Projected ServiceAccount token (k3s, later). Wins over the certificate. */
  federatedTokenFile: string | undefined;
}

export type GraphCredentialKind = 'federated' | 'certificate';

/**
 * Which credential the configuration selects, or `undefined` when Graph is off.
 *
 * Graph is on only when the tenant, the Graph app's own client id AND a credential are all present.
 * The client id is the switch: without it nothing here can authenticate, and every feature skips.
 */
export function graphCredentialKind(
  config: GraphCredentialConfig,
): GraphCredentialKind | undefined {
  if (!config.tenantId || !config.clientId) return undefined;
  if (config.federatedTokenFile) return 'federated';
  if (config.certificatePem) return 'certificate';
  return undefined;
}

/**
 * The credential for `config`. The two are interchangeable behind `TokenCredential`, so moving the
 * worker from ECS to k3s changes configuration only — see docs/graph-worker-app.md.
 */
export function buildGraphCredential(config: GraphCredentialConfig): TokenCredential {
  const kind = graphCredentialKind(config);
  if (kind === 'federated') {
    return new WorkloadIdentityCredential({
      tenantId: config.tenantId!,
      clientId: config.clientId!,
      tokenFilePath: config.federatedTokenFile!,
    });
  }
  if (kind === 'certificate') {
    return new ClientCertificateCredential(config.tenantId!, config.clientId!, {
      certificate: config.certificatePem!,
    });
  }
  throw new Error(
    'Microsoft Graph is not configured: set GRAPH_CLIENT_ID (the Graph worker app) and either ' +
      'GRAPH_FEDERATED_TOKEN_FILE or GRAPH_CLIENT_CERTIFICATE.',
  );
}
