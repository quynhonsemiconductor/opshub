import { Injectable } from '@nestjs/common';
import { and, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import { InjectDrizzle, type DrizzleDB } from '@platform';
import {
  NotificationSchedulerService,
  type NotificationTemplateVars,
} from '@platform/notifications';
import { employees, rolePermissions, userRoleAssignments } from '../../../../../db/schema';

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
   * `door.manage` and roles holding the `*` wildcard (admin), via authz.role_permissions — NOT by
   * role display name. Expired assignments and offboarded employees are excluded.
   */
  async doorManageHolders(): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ id: employees.id })
      .from(employees)
      .innerJoin(userRoleAssignments, eq(userRoleAssignments.userId, employees.id))
      .innerJoin(rolePermissions, eq(rolePermissions.roleId, userRoleAssignments.roleId))
      .where(
        and(
          inArray(rolePermissions.permissionKey, ['door.manage', '*']),
          eq(employees.status, 'active'),
          or(isNull(userRoleAssignments.expiresAt), gt(userRoleAssignments.expiresAt, sql`now()`)),
        ),
      );
    return rows.map((r) => r.id);
  }

  /** Schedule one door notification to ONE recipient (deduped by the outbox idempotency key). */
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
      idempotencyKey,
    });
  }
}
