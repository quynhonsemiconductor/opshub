import { Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { InjectDrizzle, NonRetryableError, type DrizzleDB } from '@platform';
import { employees } from '../../../../../db/schema';
import { GraphClientService } from '../graph-client.service';

/** Entra object ids are GUIDs. Anything else never reaches a URL. */
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface DirectoryUser {
  id?: string;
  userPrincipalName?: string | null;
  mail?: string | null;
}

/**
 * Entra account tasks, executed by the worker from `graph_task_outbox`.
 *
 * Permissions of the Graph worker app, per call (least privileged per Microsoft's reference):
 *   verify          GET   /users/{id}                        User.Read.All
 *   setEnabled      PATCH /users/{id}                        User.EnableDisableAccount.All + User.Read.All
 *   revokeSessions  POST  /users/{id}/revokeSignInSessions   User.RevokeSessions.All
 * At most three calls per run (see GRAPH_TASK_MAX_CALLS), each with a hard deadline.
 *
 * WHAT IS AND IS NOT GUARANTEED — stated precisely, because an earlier version of this comment claimed
 * more than the code delivers.
 *
 *   - A task names an EMPLOYEE, never a directory object. The API cannot put an Entra id, or "enable" /
 *     "disable", in a task.
 *   - The directory object acted on is whatever `employees.entra_oid` holds. That column is WRITABLE
 *     through `POST /employees` by anyone with `employee.write` (the value is validated as a GUID, not as
 *     belonging to the person), and by SSO account linking. So the API can influence WHICH object a
 *     task acts on, indirectly, by editing a row.
 *   - THE WORKER THEREFORE VERIFIES, before any change: it reads the object's `mail` and
 *     `userPrincipalName` and requires one of them to equal the employee's email (case-insensitive). An
 *     object that belongs to someone else is never touched: the task dead-letters, which raises the
 *     dead-letter alarm, and no PATCH or revoke is sent.
 *   - LEVEL-TRIGGERED. The account is set to match the employee's CURRENT status, read when the task
 *     runs, so a task queued earlier cannot override a later change of status.
 */
@Injectable()
export class EntraAccountService {
  private readonly logger = new Logger(EntraAccountService.name);

  constructor(
    private readonly graph: GraphClientService,
    @InjectDrizzle() private readonly db: DrizzleDB,
  ) {}

  async reconcile(employeeId: string): Promise<void> {
    const employee = await this.employee(employeeId);

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

    // Before ANY change: is this directory object really this person?
    await this.assertBelongsTo(employee.entraOid, employee.email, employeeId);

    if (employee.status === 'offboarded') {
      await this.setEnabled(employee.entraOid, false);
      // Disabling stops NEW sign-ins; a refresh token already issued keeps working until revoked.
      await this.revokeSessions(employee.entraOid);
      return;
    }

    /*
     * ENABLE only if the employee is still not offboarded RIGHT NOW. The status read above can be
     * minutes old by the time the identity check returns; re-reading it immediately before the one
     * change that restores access closes most of that window. (What closes the rest is that no Graph
     * call can outlive its lease: no SDK retry, a hard per-request deadline, and a lease longer than
     * the calls — see graph-task.ts. A later offboarding queues its own task, which runs after this one.)
     */
    const current = await this.employee(employeeId);
    if (!current || current.status === 'offboarded') {
      this.logger.warn(
        `Account reconcile: employee ${employeeId} was offboarded while this task ran — NOT enabling`,
      );
      return;
    }
    await this.setEnabled(employee.entraOid, true);
  }

  private async employee(employeeId: string) {
    const [row] = await this.db
      .select({ status: employees.status, entraOid: employees.entraOid, email: employees.email })
      .from(employees)
      .where(eq(employees.id, employeeId))
      .limit(1);
    return row;
  }

  /**
   * Requires the directory object's `mail` or `userPrincipalName` to equal the employee's email. The
   * values are never logged or stored in the failure message: the row records only that they differ.
   */
  private async assertBelongsTo(
    entraOid: string,
    email: string,
    employeeId: string,
  ): Promise<void> {
    const user = (await this.graph
      .client()
      .api(`/users/${encodeURIComponent(entraOid)}`)
      .select(['id', 'userPrincipalName', 'mail'])
      .get()) as DirectoryUser;

    const wanted = email.trim().toLowerCase();
    const matches = [user.mail, user.userPrincipalName].some(
      (candidate) => typeof candidate === 'string' && candidate.trim().toLowerCase() === wanted,
    );
    if (!matches) {
      throw new NonRetryableError(
        `Entra object ${entraOid} does not belong to employee ${employeeId}: neither its mail nor its ` +
          `userPrincipalName equals the employee's email. Nothing was changed. If entra_oid is wrong, ` +
          `correct it and requeue.`,
      );
    }
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
