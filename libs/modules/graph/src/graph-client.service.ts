import { Injectable, Logger } from '@nestjs/common';
import { Client } from '@microsoft/microsoft-graph-client';
import { TokenCredentialAuthenticationProvider } from '@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials/index.js';
import { WorkerConfigService } from '@platform';
import { buildGraphCredential, graphCredentialKind } from './graph-credential';
import { buildGraphMiddleware } from './graph-http';

/**
 * The `.default` scope: "every application permission this app registration has been granted".
 * Client-credentials has no user to consent, so a scope list would be a second place to keep in step
 * with the registration.
 */
const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';

/**
 * The one Graph client, and the one answer to whether Graph is configured. WORKER ONLY.
 *
 * Nothing in the API process imports `GraphModule`, so the API has no Graph credential, no Graph
 * client and no way to call Graph: a request that needs Graph writes a row to `graph_task_outbox`
 * and the worker does it (see `GraphTaskQueue`).
 *
 * BUILT ONCE. Both credentials cache their access token in the instance, so a client per call would
 * cost a token round trip to Entra per operation, and Entra throttles that endpoint.
 *
 * OFF IS QUIET. With no GRAPH_CLIENT_ID `isEnabled()` is false, and the first caller to ask causes one
 * info line saying so. Every Graph path checks it first and returns, so an unconsented tenant gets
 * silence rather than a 403 per cron tick.
 */
@Injectable()
export class GraphClientService {
  private readonly logger = new Logger(GraphClientService.name);
  private cached: Client | undefined;
  private announcedOff = false;

  constructor(private readonly config: WorkerConfigService) {}

  private credentialConfig() {
    return {
      tenantId: this.config.get('ENTRA_TENANT_ID'),
      clientId: this.config.get('GRAPH_CLIENT_ID'),
      certificatePath: this.config.get('AZURE_CLIENT_CERTIFICATE_PATH'),
      federatedTokenFile: this.config.get('GRAPH_FEDERATED_TOKEN_FILE'),
    };
  }

  /** True when Graph can authenticate. Logs once, at info, the first time the answer is no. */
  isEnabled(): boolean {
    const enabled = graphCredentialKind(this.credentialConfig()) !== undefined;
    if (!enabled && !this.announcedOff) {
      this.announcedOff = true;
      this.logger.log(
        'Microsoft Graph is off (GRAPH_CLIENT_ID and a credential are not configured): Intune ' +
          'sync, shadow-IT scan, Secure Score and Entra account tasks are skipped.',
      );
    }
    return enabled;
  }

  /**
   * The shared client. Throws if Graph is not configured — check `isEnabled()` first. Deliberately not
   * a no-op client: a caller that skipped the check is about to disable an account, and silently doing
   * nothing would report success for work that never happened.
   */
  client(): Client {
    if (this.cached) return this.cached;
    const credential = buildGraphCredential(this.credentialConfig());
    this.cached = Client.initWithMiddleware({
      // Our own chain: no SDK retry loop, a hard deadline per request. See graph-http.ts.
      middleware: buildGraphMiddleware(
        new TokenCredentialAuthenticationProvider(credential, { scopes: [GRAPH_SCOPE] }),
      ),
    });
    this.logger.log(
      `Microsoft Graph client initialised (${graphCredentialKind(this.credentialConfig())} credential)`,
    );
    return this.cached;
  }
}
