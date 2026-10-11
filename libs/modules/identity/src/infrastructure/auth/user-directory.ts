import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { InjectDrizzle, type DbExecutor, type DrizzleDB } from '@platform';
import { user } from '../../../../../../db/schema';

/** The slice of an employee the identity user is made from. */
export interface DirectoryEmployee {
  id: string;
  email: string;
  displayName: string;
  status: string;
}

/**
 * `identity.user` and `identity.employees` are two tables for ONE person, and their ids are the same:
 * `identity.user.id = identity.employees.id`. That is the invariant every foreign key to an employee in
 * this codebase depends on once authentication runs on identity 8, where the session's user id becomes
 * `request.user.sub`.
 *
 * It is kept in step from both directions:
 *  - HR creates or edits an employee (`EmployeeService`): this writes the user, in the SAME transaction;
 *  - a person signs in who has no employee (`StaffSignInHandler`): the employee is created with the user's id.
 * The migration (0037) established it for everyone who existed.
 *
 * The identity user is looked up by email on a Microsoft sign-in (Better Auth links the Entra account to the
 * user whose address matches), so an HR-created employee MUST already have a user, or the sign-in would
 * create one with a new id.
 */
@Injectable()
export class UserDirectory {
  constructor(@InjectDrizzle() private readonly db: DrizzleDB) {}

  /**
   * Insert the identity user for this employee, or bring its name and address up to date. A ban is never
   * touched on conflict: banning and unbanning belong to offboarding (`SessionRevoker`).
   */
  async ensure(employee: DirectoryEmployee, tx?: DbExecutor): Promise<void> {
    await (tx ?? this.db)
      .insert(user)
      .values({
        id: employee.id,
        name: employee.displayName,
        email: employee.email.toLowerCase(),
        emailVerified: true, // an employee is a tenant member: the company vouches for the address
        banned: employee.status === 'offboarded',
        banReason: employee.status === 'offboarded' ? 'offboarded' : null,
      })
      .onConflictDoUpdate({
        target: user.id,
        set: {
          name: employee.displayName,
          email: employee.email.toLowerCase(),
          updatedAt: sql`now()`,
        },
      });
  }
}
