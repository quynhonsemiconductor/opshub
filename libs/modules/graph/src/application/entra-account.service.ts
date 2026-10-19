import { Injectable, Logger } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { InjectDrizzle, NonRetryableError, type DrizzleDB } from '@platform';
import { employees } from '../../../../../db/schema';
import { GraphClientService } from '../graph-client.service';
import { MIN_LEASE_TO_MUTATE_MS } from '../graph-task';

/** Entra object ids are GUIDs. Anything else never reaches a URL. */
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface DirectoryUser {
  id?: string;
  userPrincipalName?: string | null;
  mail?: string | null;
  /** `SMTP:primary@x`, `smtp:alias@x`, `x500:…`, `SIP:…` */
  proxyAddresses?: string[] | null;
}

/**
 * Entra account tasks, executed by the worker from `graph_task_outbox`.
 *
 * Permissions of the Graph worker app, per call (least privileged per Microsoft's reference):
 *   verify          GET   /users/{id}                        User.Read.All
 *   setEnabled      PATCH /users/{id}                        User.EnableDisableAccount.All + User.Read.All
 *   revokeSessions  POST  /users/{id}/revokeSignInSessions   User.RevokeSessions.All
 * At most three calls per run (see GRAPH_TASK_MAX_CALLS), each with a hard deadline that starts before
 * the access token is requested.
 *
 * WHAT IS AND IS NOT GUARANTEED — stated precisely, because earlier versions of this comment claimed
 * more than the code delivers.
 *
 *   - A task names an EMPLOYEE, never a directory object. The API cannot put an Entra id, or "enable" /
 *     "disable", in a task.
 *   - The object acted on is whatever `employees.entra_oid` holds, and that column is WRITABLE: through
 *     `POST /employees` by a holder of `employee.write` (validated as a GUID, not as belonging to the
 *     person) and by SSO account linking. `PATCH /employees` cannot change it (nor the email).
 *   - The worker therefore CHECKS before any change that the object's `mail`, `userPrincipalName` or one
 *     of its `smtp:` proxy addresses equals the employee's email (case-insensitive). That stops an
 *     accidental or one-sided mistake — an `entra_oid` pasted onto the wrong row, an object that
 *     belongs to someone else — and the task dead-letters (alarm) instead of touching it.
 *   - It is NOT proof of ownership against a deliberate attacker who can edit BOTH fields. Whoever
 *     holds `employee.write` can set an employee's email to the address of a directory object that has
 *     no employee row of its own (a service account, an external guest) and `entra_oid` to its id; the
 *     uniqueness of `employees.email` only protects addresses that already have an employee row. The
 *     limits on the damage are Microsoft's: an application with these permissions cannot disable or
 *     revoke a user who holds a privileged directory role (the call returns 403 and the task
 *     dead-letters), and every change is in the audit trail of the approval that queued it. Treat
 *     `employee.write` as able to influence which account an offboarding disables.
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

  /**
   * `leaseExpiresAt` is when this run's lease on the task lapses. Before each CHANGE, enough of it must
   * remain for the call to finish (a full deadline plus a margin); otherwise the run steps aside (the
   * attempt is refunded) rather than start a call that could land after another worker has taken over.
   */
  async reconcile(employeeId: string, leaseExpiresAt: Date): Promise<void> {
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
      await this.assertTimeToMutate(leaseExpiresAt, employeeId);
      await this.setEnabled(employee.entraOid, false);
      // Disabling stops NEW sign-ins; a refresh token already issued keeps working until revoked.
      await this.assertTimeToMutate(leaseExpiresAt, employeeId);
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
    await this.assertTimeToMutate(leaseExpiresAt, employeeId);
    await this.setEnabled(employee.entraOid, true);
  }

  /**
   * Refuses to START a change when the lease is too close to its end for the call to finish inside it.
   * An ordinary retryable failure, NOT a DeferError: the attempt is counted, so a task that keeps arriving
   * here (its identity check always eats the lease) backs off, runs out of attempts and dead-letters with
   * the alarm, instead of being refunded for ever.
   */
  private async assertTimeToMutate(leaseExpiresAt: Date, employeeId: string): Promise<void> {
    // The lease is the DATABASE's instant (locked_until, stamped from its own now()), so the time left is measured
    // against the database's now(), never the host's (the Time rule, .github#29).
    const left = await this.db.execute<{ left: number | string }>(
      // The Date is BOUND as a parameter. A string here would be inlined as SQL text, not sent as a value.
      sql`SELECT extract(epoch FROM (${leaseExpiresAt}::timestamptz - now())) * 1000 AS left`,
    );
    const remaining = Number(left.rows[0]?.left);
    // Fails closed: an answer that is not a number (no lease, a failed read) is not enough lease.
    if (!(remaining >= MIN_LEASE_TO_MUTATE_MS)) {
      throw new Error(
        `Account reconcile for employee ${employeeId}: ${Math.max(0, Math.round(remaining / 1000))} s of ` +
          `lease left, less than a call needs (${MIN_LEASE_TO_MUTATE_MS / 1000} s) — not starting a change`,
      );
    }
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
   * Requires the directory object's `mail`, `userPrincipalName` or an `smtp:` proxy address (the
   * `smtp:` / `SMTP:` prefix stripped) to equal the employee's email, case-insensitively — aliases are
   * how people really sign in. The values are never logged or stored in the failure message: the row
   * records only that none matched.
   */
  private async assertBelongsTo(
    entraOid: string,
    email: string,
    employeeId: string,
  ): Promise<void> {
    const user = (await this.graph
      .client()
      .api(`/users/${encodeURIComponent(entraOid)}`)
      .select(['id', 'userPrincipalName', 'mail', 'proxyAddresses'])
      .get()) as DirectoryUser;

    const wanted = email.trim().toLowerCase();
    const aliases = (user.proxyAddresses ?? [])
      .filter((a) => /^smtp:/i.test(a))
      .map((a) => a.replace(/^smtp:/i, ''));
    const matches = [user.mail, user.userPrincipalName, ...aliases].some(
      (candidate) => typeof candidate === 'string' && candidate.trim().toLowerCase() === wanted,
    );
    if (!matches) {
      throw new NonRetryableError(
        `Entra object ${entraOid} does not belong to employee ${employeeId}: none of its mail, userPrincipalName ` +
          `or smtp addresses equals the employee's email. Nothing was changed. If entra_oid is wrong, ` +
          `correct it and requeue.`,
      );
    }
  }

  async setEnabled(entraOid: string, enabled: boolean): Promise<void> {
    await this.writeOrRefuse(
      'User.EnableDisableAccount.All',
      enabled ? 'enable' : 'disable',
      entraOid,
      () =>
        this.graph
          .client()
          .api(`/users/${encodeURIComponent(entraOid)}`)
          .patch({ accountEnabled: enabled }),
    );
    this.logger.log(`${enabled ? 'Enabled' : 'Disabled'} Entra account OID=${entraOid}`);
  }

  /** Invalidates the user's refresh tokens and session cookies. Not applicable to external (guest) users. */
  async revokeSessions(entraOid: string): Promise<void> {
    await this.writeOrRefuse('User.RevokeSessions.All', 'revoke sessions of', entraOid, () =>
      this.graph
        .client()
        .api(`/users/${encodeURIComponent(entraOid)}/revokeSignInSessions`)
        .post({}),
    );
    this.logger.log(`Revoked sign-in sessions for Entra OID=${entraOid}`);
  }

  /*
   * FAIL CLOSED. The two WRITE permissions are not granted everywhere: develop shares the real tenant, so its app holds only the three READ
   * permissions and must not be able to disable or sign out a real account (docs/graph-worker-app.md). Graph answers such a call with 403.
   * That is turned into one clear, non-retried failure: nothing was changed, the log says which permission and why that may be intended, and the
   * task dead-letters (alarm) instead of retrying a call that cannot succeed. Any other error is left to the relay's own classification.
   */
  private async writeOrRefuse(
    permission: 'User.EnableDisableAccount.All' | 'User.RevokeSessions.All',
    action: string,
    entraOid: string,
    call: () => Promise<unknown>,
  ): Promise<void> {
    try {
      await call();
    } catch (err) {
      if ((err as { statusCode?: number } | undefined)?.statusCode !== 403) throw err;
      this.logger.error(
        { permission, entraOid },
        `Refused to ${action} Entra account ${entraOid}: Graph answered 403. This app is not allowed to (it lacks ${permission}, which develop deliberately does not hold, or the user holds a privileged directory role). Nothing was changed.`,
      );
      throw new NonRetryableError(
        `Graph 403: not permitted to ${action} the account (${permission} missing, or a privileged user). Nothing was changed.`,
      );
    }
  }
}
