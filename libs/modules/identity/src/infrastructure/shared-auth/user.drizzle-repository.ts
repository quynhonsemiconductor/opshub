import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { InjectDrizzle, type DrizzleDB, type DbExecutor } from '@platform';
import type { IUserRepository, SsoIdentity, User, UserStatus } from '@quynhonsemiconductor/identity';
import { employees, ssoIdentities } from '../../../../../../db/schema';

type EmployeeRow = typeof employees.$inferSelect;

/**
 * Map opshub's `employee_status` enum onto the shared package's `UserStatus`.
 * opshub has no `invited`/`suspended` states; `on_leave` employees remain
 * authenticatable (their access is governed by RBAC, not the auth gate), while
 * `offboarded` maps to `inactive` so the shared AuthService's deactivation gate
 * blocks their login.
 */
function toUserStatus(status: EmployeeRow['status']): UserStatus {
  switch (status) {
    case 'offboarded':
      return 'inactive';
    case 'active':
    case 'on_leave':
    default:
      return 'active';
  }
}

function toEmployeeStatus(status: string): EmployeeRow['status'] {
  switch (status) {
    case 'inactive':
    case 'suspended':
      return 'offboarded';
    case 'active':
    case 'invited':
    default:
      return 'active';
  }
}

/**
 * Project an `employees` row onto the shared package's `User` shape. opshub does
 * not model avatar/locale/timezone/emailVerified/sessionVersion/lastLoginAt on
 * the employee record, so those carry safe constant defaults — the shared
 * AuthService only reads `id`, `email`, `displayName`, `status`, and `deletedAt`
 * on the authentication path.
 */
function toUser(row: EmployeeRow): User {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    avatarUrl: null,
    status: toUserStatus(row.status),
    emailVerified: true,
    locale: 'en',
    timezone: 'UTC',
    sessionVersion: 0,
    lastLoginAt: null,
    deletedAt: null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * opshub binding for the shared `IUserRepository` port. Resolves and
 * JIT-provisions employees through the `sso_identities` link table while keeping
 * `employees.entra_oid` in sync for existing RBAC queries.
 */
@Injectable()
export class UserDrizzleRepository implements IUserRepository<DbExecutor> {
  constructor(@InjectDrizzle() private readonly db: DrizzleDB) {}

  async findByEmail(email: string): Promise<User | null> {
    const [row] = await this.db.select().from(employees).where(eq(employees.email, email)).limit(1);
    return row ? toUser(row) : null;
  }

  async findById(id: string): Promise<User | null> {
    const [row] = await this.db.select().from(employees).where(eq(employees.id, id)).limit(1);
    return row ? toUser(row) : null;
  }

  async updateLastLogin(id: string, tx?: DbExecutor): Promise<void> {
    const db = tx ?? this.db;
    await db.update(employees).set({ updatedAt: new Date() }).where(eq(employees.id, id));
  }

  async updateStatus(id: string, status: string, tx?: DbExecutor): Promise<void> {
    const db = tx ?? this.db;
    await db
      .update(employees)
      .set({ status: toEmployeeStatus(status), updatedAt: new Date() })
      .where(eq(employees.id, id));
  }

  async updateProfile(
    id: string,
    input: { displayName?: string; avatarUrl?: string | null; locale?: string; timezone?: string },
  ): Promise<User> {
    if (input.displayName !== undefined) {
      await this.db
        .update(employees)
        .set({ displayName: input.displayName, updatedAt: new Date() })
        .where(eq(employees.id, id));
    }
    const [row] = await this.db.select().from(employees).where(eq(employees.id, id)).limit(1);
    if (!row) {
      throw new Error(`Employee ${id} not found`);
    }
    return toUser(row);
  }

  async findSsoIdentity(provider: string, providerSub: string): Promise<SsoIdentity | null> {
    const [row] = await this.db
      .select()
      .from(ssoIdentities)
      .where(and(eq(ssoIdentities.provider, provider), eq(ssoIdentities.providerSub, providerSub)))
      .limit(1);
    return row
      ? {
          id: row.id,
          userId: row.userId,
          provider: row.provider,
          providerSub: row.providerSub,
          providerEmail: row.providerEmail,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        }
      : null;
  }

  async upsertBySsoIdentity(
    provider: string,
    providerSub: string,
    providerEmail: string,
    displayName: string,
    tx?: DbExecutor,
  ): Promise<User> {
    const run = async (db: DbExecutor): Promise<User> => {
      // 1. Find-or-create the employee by email (the natural key for opshub's
      //    single-tenant directory).
      let [employee] = await db
        .select()
        .from(employees)
        .where(eq(employees.email, providerEmail))
        .limit(1);

      if (!employee) {
        [employee] = await db
          .insert(employees)
          .values({
            email: providerEmail,
            displayName: displayName || providerEmail,
            entraOid: provider === 'entra' ? providerSub : null,
          })
          .returning();
      } else if (provider === 'entra' && employee.entraOid !== providerSub) {
        [employee] = await db
          .update(employees)
          .set({ entraOid: providerSub, updatedAt: new Date() })
          .where(eq(employees.id, employee.id))
          .returning();
      }

      // 2. Ensure the SSO identity link exists (idempotent across repeat logins).
      await db
        .insert(ssoIdentities)
        .values({ userId: employee.id, provider, providerSub, providerEmail })
        .onConflictDoUpdate({
          target: [ssoIdentities.provider, ssoIdentities.providerSub],
          set: { providerEmail, updatedAt: new Date() },
        });

      return toUser(employee);
    };

    return tx ? run(tx) : this.db.transaction((t) => run(t as DbExecutor));
  }
}
