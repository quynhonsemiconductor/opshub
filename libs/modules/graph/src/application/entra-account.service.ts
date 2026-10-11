import { Injectable, Logger } from '@nestjs/common';
import { GraphClientService } from '../graph-client.service';

/**
 * Entra account tasks, executed by the worker from `graph_task_outbox`.
 *
 * Permissions of the Graph worker app, per call (least privileged per Microsoft's reference):
 *   setEnabled      PATCH /users/{id}                        User.EnableDisableAccount.All + User.Read.All
 *   revokeSessions  POST  /users/{id}/revokeSignInSessions   User.RevokeSessions.All
 *
 * Both THROW on failure — the relay turns that into a retry with backoff and, after the last attempt, a
 * dead-lettered row. They were best-effort calls inside an approval request; an approval that "succeeds"
 * while the account stays enabled is the failure this exists to remove.
 */
@Injectable()
export class EntraAccountService {
  private readonly logger = new Logger(EntraAccountService.name);

  constructor(private readonly graph: GraphClientService) {}

  async setEnabled(entraOid: string, enabled: boolean): Promise<void> {
    await this.graph.client().api(`/users/${entraOid}`).patch({ accountEnabled: enabled });
    this.logger.log(`${enabled ? 'Enabled' : 'Disabled'} Entra account OID=${entraOid}`);
  }

  /**
   * Invalidates the user's refresh tokens and session cookies. Disabling an account stops NEW sign-ins;
   * a refresh token already issued keeps working until this runs.
   */
  async revokeSessions(entraOid: string): Promise<void> {
    await this.graph.client().api(`/users/${entraOid}/revokeSignInSessions`).post({});
    this.logger.log(`Revoked sign-in sessions for Entra OID=${entraOid}`);
  }
}
