import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { InjectDrizzle, type DrizzleDB } from '../database/drizzle.provider';
import { NotFoundException } from '../errors/exceptions';
import { employees } from '../../../../db/schema/identity';
import { assets } from '../../../../db/schema/assets';
import { timesheets, leaveRequests, overtimeEntries } from '../../../../db/schema/workforce';
import { cards as doorCards, terminals as doorTerminals } from '../../../../db/schema/door';
import type { ResourceAttrs, ScopedResource } from './authz.types';

/**
 * Resolves the scope attributes of the resource a guard is about to authorize, for
 * routes that carry only the resource's own id.
 *
 * One indexed primary-key lookup, and only for routes that declare a
 * `{ resource, … }` scope — an unscoped route never reaches this. A missing row
 * raises NotFound rather than denying, so a bad id is an honest 404 instead of a
 * misleading 403.
 *
 * Written as one explicit query per resource rather than a generic
 * table+column helper. The generic version needs Drizzle's column types threaded
 * through a signature that does not typecheck cleanly, and the abstraction it buys
 * is four lines. Explicit also documents the thing that actually matters: which
 * column means "owner" for each resource — `assets.assigned_to` and
 * `timesheets.employee_id` are both owners, and no naming convention says so.
 */
@Injectable()
export class ResourceScopeResolver {
  constructor(@InjectDrizzle() private readonly db: DrizzleDB) {}

  async resolve(resource: ScopedResource, id: string): Promise<ResourceAttrs> {
    switch (resource) {
      case 'employee':
        return this.employee(id);
      case 'asset':
        return this.asset(id);
      case 'timesheet':
        return this.timesheet(id);
      case 'leave_request':
        return this.leaveRequest(id);
      case 'overtime':
        return this.overtime(id);
      case 'door_card':
        return this.doorCard(id);
      case 'door_terminal':
        return this.doorTerminal(id);
    }
  }

  /**
   * A card's owner is the employee it belongs to — so a `self`-scoped grant, should one ever be
   * issued, would let a person act on their own card. No role bundle grants a scoped door code
   * today; the case exists so the descriptor is honest about who the row belongs to.
   */
  private async doorCard(id: string): Promise<ResourceAttrs> {
    const [row] = await this.db
      .select({ employeeId: doorCards.employeeId })
      .from(doorCards)
      .where(eq(doorCards.id, id))
      .limit(1);

    if (!row) throw new NotFoundException('DOOR_CARD_NOT_FOUND', 'Card not found');
    return { ownerId: row.employeeId };
  }

  /** A terminal belongs to nobody: no scope attributes, like unassigned stock. */
  private async doorTerminal(id: string): Promise<ResourceAttrs> {
    const [row] = await this.db
      .select({ id: doorTerminals.id })
      .from(doorTerminals)
      .where(eq(doorTerminals.id, id))
      .limit(1);

    if (!row) throw new NotFoundException('DOOR_TERMINAL_NOT_FOUND', 'Terminal not found');
    return {};
  }

  /**
   * An employee is their own owner, and carries the only department the schema
   * records. `department` is a NAME (varchar), not a foreign key, so a `dept`-scoped
   * grant stores that same name in `scope_id` — there is no departments table.
   */
  private async employee(id: string): Promise<ResourceAttrs> {
    const [row] = await this.db
      .select({ id: employees.id, department: employees.department })
      .from(employees)
      .where(eq(employees.id, id))
      .limit(1);

    if (!row) throw new NotFoundException('EMPLOYEE_NOT_FOUND', 'Employee not found');
    return { ownerId: row.id, ...(row.department ? { deptId: row.department } : {}) };
  }

  /**
   * An unassigned asset has no owner, so `ownerId` is absent and a `self` grant
   * cannot match it. That is correct rather than a gap: nobody owns stock.
   */
  private async asset(id: string): Promise<ResourceAttrs> {
    const [row] = await this.db
      .select({ assignedTo: assets.assignedTo })
      .from(assets)
      .where(eq(assets.id, id))
      .limit(1);

    if (!row) throw new NotFoundException('ASSET_NOT_FOUND', 'Asset not found');
    return row.assignedTo ? { ownerId: row.assignedTo } : {};
  }

  private async timesheet(id: string): Promise<ResourceAttrs> {
    const [row] = await this.db
      .select({ employeeId: timesheets.employeeId })
      .from(timesheets)
      .where(eq(timesheets.id, id))
      .limit(1);

    if (!row) throw new NotFoundException('TIMESHEET_NOT_FOUND', 'Timesheet not found');
    return { ownerId: row.employeeId };
  }

  private async leaveRequest(id: string): Promise<ResourceAttrs> {
    const [row] = await this.db
      .select({ employeeId: leaveRequests.employeeId })
      .from(leaveRequests)
      .where(eq(leaveRequests.id, id))
      .limit(1);

    if (!row) throw new NotFoundException('LEAVE_REQUEST_NOT_FOUND', 'Leave request not found');
    return { ownerId: row.employeeId };
  }

  private async overtime(id: string): Promise<ResourceAttrs> {
    const [row] = await this.db
      .select({ employeeId: overtimeEntries.employeeId })
      .from(overtimeEntries)
      .where(eq(overtimeEntries.id, id))
      .limit(1);

    if (!row) throw new NotFoundException('OVERTIME_NOT_FOUND', 'Overtime entry not found');
    return { ownerId: row.employeeId };
  }
}
