import { Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { InjectDrizzle, NonRetryableError, type DrizzleDB } from '@platform';
import { employees } from '../../../../../db/schema';
import { GraphClientService } from '../graph-client.service';

/** Entra object ids are GUIDs. Anything else never reaches a URL. */
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Entra account tasks, executed by the worker from `graph_task_outbox`.
 *
 * Permissions of the Graph worker app, per call (least privileged per Microsoft's reference):
 *   setEnabled      PATCH /users/{id}                        User.EnableDisableAccount.All + User.Read.All
 *   revokeSessions  POST  /users/{id}/revokeSignInSessions   User.RevokeSessions.All
 *
 * LEVEL-TRIGGERED. `reconcile(employeeId)` reads the employee's status and Entra object id NOW, from the
 * database, and sets the account to match — it is told WHO, never WHAT. A task queued while the employee
 * was active and run after they were offboarded therefore disables the account; it can never carry a
 * stale "enable" past a later offboarding. And because the API names an employee rather than a directory
 * object, it cannot aim a task at an arbitrary account.
 */
@Injectable()
export class EntraAccountService {
  private readonly logger = new Logger(EntraAccountService.name);

  constructor(
    private readonly graph: GraphClientService,
    @InjectDrizzle() private readonly db: DrizzleDB,
  ) {}

  async reconcile(employeeId: string): Promise<void> {
    const [employee] = await this.db
      .select({ status: employees.status, entraOid: employees.entraOid })
      .from(employees)
      .where(eq(employees.id, employeeId))
      .limit(1);

    if (!employee) {
      this.logger.warn(
        `Account reconcile: employee ${employeeId} no longer exists — nothing to do`,
      );
      return;
    }
    if (!employee.entraOid) {
      this.logger.warn(
        `Account reconcile: employee ${employeeId} has no Entra OID — nothing to do`,
      );
      return;
    }
    if (!GUID.test(employee.entraOid)) {
      // Not retryable: the stored value is wrong and trying again will not make it a GUID.
      throw new NonRetryableError(
        `Employee ${employeeId} has an entra_oid that is not a GUID; refusing to build a Graph URL from it`,
      );
    }

    const offboarded = employee.status === 'offboarded';
    await this.setEnabled(employee.entraOid, !offboarded);
    // Disabling stops NEW sign-ins; a refresh token already issued keeps working until revoked.
    if (offboarded) await this.revokeSessions(employee.entraOid);
  }

  async setEnabled(entraOid: string, enabled: boolean): Promise<void> {
    await this.graph
      .client()
      .api(`/users/${encodeURIComponent(entraOid)}`)
      .patch({ accountEnabled: enabled });
    this.logger.log(`${enabled ? 'Enabled' : 'Disabled'} Entra account OID=${entraOid}`);
  }

  /** Invalidates the user's refresh tokens and session cookies. Not applicable to external (guest) users. */
  async revokeSessions(entraOid: string): Promise<void> {
    await this.graph
      .client()
      .api(`/users/${encodeURIComponent(entraOid)}/revokeSignInSessions`)
      .post({});
    this.logger.log(`Revoked sign-in sessions for Entra OID=${entraOid}`);
  }
}
