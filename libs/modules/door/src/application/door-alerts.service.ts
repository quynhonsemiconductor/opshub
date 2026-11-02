import { Injectable } from '@nestjs/common';
import { and, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import { InjectDrizzle, type DrizzleDB } from '@platform';
import {
  NotificationSchedulerService,
  type NotificationTemplateVars,
} from '@platform/notifications';
import {
  employeePermissions,
  employees,
  groupPermissions,
  employeeGroups,
} from '../../../../../db/schema';

/**
 * The door module's notification sender: WHO gets door alerts (the permission-based holders query)
 * and HOW they go out (the notification outbox). ONE service because both alert paths — the
 * low-battery transition in the API's DoorService and the offline transition in the worker's
 * DoorTerminalHealthCron — must agree on recipients and the outbox write, and the two crons live
 * in different modules (DoorModule vs DoorJobsModule); this service is provided by BOTH.
 */
@Injectable()
export class DoorAlertsService {
  constructor(
    @InjectDrizzle() private readonly db: DrizzleDB,
    private readonly notificationsScheduler: NotificationSchedulerService,
  ) {}

  /**
   * Active employees whose EFFECTIVE permissions include door.manage: the union of roles granted
   * `door.manage`, roles holding the `*` wildcard (admin), and permissions granted straight to the
   * employee — via authz.role_permissions and authz.employee_permissions, NOT by role display name.
   * Expired grants and offboarded employees are excluded.
   */
  async doorManageHolders(): Promise<string[]> {
    const [viaGroups, viaDirectGrants] = await Promise.all([
      this.db
        .selectDistinct({ id: employees.id })
        .from(employees)
        .innerJoin(employeeGroups, eq(employeeGroups.employeeId, employees.id))
        .innerJoin(groupPermissions, eq(groupPermissions.groupId, employeeGroups.groupId))
        .where(
          and(
            inArray(groupPermissions.permissionKey, ['door.manage', '*']),
            eq(employees.status, 'active'),
            or(isNull(employeeGroups.expiresAt), gt(employeeGroups.expiresAt, sql`now()`)),
          ),
        ),
      this.db
        .selectDistinct({ id: employees.id })
        .from(employees)
        .innerJoin(employeePermissions, eq(employeePermissions.employeeId, employees.id))
        .where(
          and(
            inArray(employeePermissions.permissionKey, ['door.manage', '*']),
            eq(employees.status, 'active'),
            or(
              isNull(employeePermissions.expiresAt),
              gt(employeePermissions.expiresAt, sql`now()`),
            ),
          ),
        ),
    ]);
    return [...new Set([...viaGroups, ...viaDirectGrants].map((r) => r.id))];
  }

  /**
   * Schedule one door notification to ONE recipient. The outbox's unique index is on the key
   * alone, so the recipient id is appended here: callers pass the base key (per event/day) and
   * every holder still gets their own row, while a resend to the same holder is deduped.
   */
  async send<K extends 'door.low_battery' | 'door.terminal_offline'>(
    recipientId: string,
    type: K,
    vars: NotificationTemplateVars[K],
    idempotencyKey: string,
    resourceId?: string,
  ): Promise<void> {
    await this.notificationsScheduler.schedule(this.db, {
      type,
      recipientId,
      resourceId,
      vars,
      idempotencyKey: `${idempotencyKey}:${recipientId}`,
    });
  }
}
