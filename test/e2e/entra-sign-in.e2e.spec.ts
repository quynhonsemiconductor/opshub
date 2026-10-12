/**
 * The Microsoft sign-in, end to end, against identity's mock Entra.
 *
 * Every other e2e spec signs in through `/api/auth/test-login`, which finds the user and mints a session:
 * it skips the Microsoft flow, and with it the one hook that carries opshub's product behaviour,
 * `hooks.onStaffSignIn` (employee provisioning and the role reconcile). This spec runs the real flow
 * (authorize, PKCE, token exchange, id_token checks, user linking, the hook, the session) with the same
 * `createOpshubIdentity` factory the API uses, then presents the resulting cookie to the REAL API.
 *
 * What it proves, and what it cannot:
 *  - the person who signs in IS the employee HR created: `sub` equals the existing `employees.id`
 *    (the decision that keeps every foreign key in the product valid across the cutover);
 *  - App Roles reconcile into the role assignments on every sign-in, and no role means `employee`;
 *  - an unknown person from the tenant is provisioned, with `id = user.id`;
 *  - another tenant, and an address outside `qnsc.vn`, get no session.
 *  Not provable here: Entra's own behaviour (the single-tenant app registration, the `email` optional claim,
 *  the real redirect URI registration). Those are the manual checks in the plan, M3.
 *
 * A second `Identity` instance built over the app's own database, cache and secret: the cookie it signs is
 * accepted by the API's instance because both derive from the same `BETTER_AUTH_SECRET`.
 *
 * Prereqs: `docker compose -f docker-compose.dev.yml up -d`, `pnpm db:migrate`, `pnpm db:seed`.
 */
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { eq } from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Identity } from '@quynhonsemiconductor/identity';
import { CacheService } from '@quynhonsemiconductor/platform-cache';
import {
  TestClient,
  startMockIdp,
  type IdpIdentity,
  type MockIdp,
} from '@quynhonsemiconductor/identity/testing';
import { AppConfigService, DRIZZLE, SESSION_COOKIE, type DrizzleDB, type Env } from '@platform';
import { employees, user as identityUser } from '../../db/schema';
import { createOpshubIdentity } from '../../libs/modules/identity/src/infrastructure/auth/create-opshub-identity';
import { SecurityEventAuditSink } from '../../libs/modules/identity/src/infrastructure/auth/security-events.audit';
import { StaffSignInHandler } from '../../libs/modules/identity/src/infrastructure/auth/staff-sign-in.handler';
import {
  FIXTURE,
  authHeaders,
  createTestApp,
  login,
  unwrap,
  type Session,
} from './support/harness';

const TENANT = '33333333-3333-4333-8333-333333333333';
const OTHER_TENANT = '44444444-4444-4444-8444-444444444444';
const RUN = Date.now().toString(36).slice(-6);

let app: NestFastifyApplication;
let db: DrizzleDB;
let idp: MockIdp;
let identity: Identity;
let appUrl: string;
let admin: Session;
let seq = 0;

/** A fresh Microsoft identity; roles are the Entra App Roles claim. */
function person(roles: string[] | undefined, over: Partial<IdpIdentity> = {}): IdpIdentity {
  const n = ++seq;
  return {
    sub: `idp-sub-${RUN}-${n}`,
    oid: `00000000-0000-4000-8000-${RUN.padStart(6, '0')}${String(n).padStart(6, '0')}`,
    tid: TENANT,
    email: `signin.${RUN}.${n}@qnsc.vn`,
    name: `Sign In ${n}`,
    ...(roles ? { claims: { roles } } : {}),
    ...over,
  };
}

/**
 * Sign in through the mock Entra, every hop visible. Returns the `cookie` header (undefined if refused), the
 * callback's status, and the `error` code identity redirected the browser with (undefined on success).
 */
async function microsoftSignIn(
  who: IdpIdentity,
): Promise<{ cookie?: string; status: number; error?: string }> {
  idp.loginAs(who);
  const client = new TestClient(appUrl, identity.handler, { origin: appUrl });
  const start = await client.post('/api/auth/sign-in/social', {
    provider: 'microsoft',
    callbackURL: '/',
  });
  expect(start.status, start.body).toBe(200);
  const authz = await client.get(start.json<{ url: string }>().url);
  const callback = await client.get(authz.location ?? '');
  const value = client.cookies[SESSION_COOKIE];
  const error = callback.location
    ? (new URL(callback.location, appUrl).searchParams.get('error') ?? undefined)
    : undefined;
  return {
    status: callback.status,
    ...(error ? { error } : {}),
    ...(value ? { cookie: `${SESSION_COOKIE}=${value}` } : {}),
  };
}

async function me(cookie: string) {
  const res = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: { cookie } });
  return {
    status: res.statusCode,
    body: res.json<{ sub: string; roles: string[]; permissions: string[] }>(),
  };
}

async function createEmployee(email: string, roles: string[] = []): Promise<{ id: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/employees',
    headers: authHeaders(admin),
    payload: { email, displayName: 'Created by HR', roles },
  });
  expect(res.statusCode, res.body).toBe(201);
  return unwrap<{ id: string }>(JSON.parse(res.body));
}

beforeAll(async () => {
  app = await createTestApp();
  db = app.get<DrizzleDB>(DRIZZLE);
  const real = app.get(AppConfigService);
  appUrl = real.get('APP_URL');
  idp = await startMockIdp();

  const config = {
    get: (key: keyof Env) =>
      ({
        ENTRA_TENANT_ID: TENANT,
        ENTRA_CLIENT_ID: 'e2e-client',
        ENTRA_CLIENT_SECRET: 'e2e-secret',
      })[key as string] ?? real.get(key),
  } as AppConfigService;

  identity = createOpshubIdentity({
    config,
    db,
    cache: app.get(CacheService, { strict: false }),
    staffSignIn: app.get(StaffSignInHandler, { strict: false }),
    auditSink: app.get(SecurityEventAuditSink, { strict: false }),
    logger: await app.resolve(PinoLogger, undefined, { strict: false }),
    staffAuthority: idp.base,
  });
  admin = await login(app, FIXTURE.ADMIN);
}, 60_000);

afterAll(async () => {
  await idp?.stop();
  await app?.close();
});

describe('Microsoft sign-in with the staff preset', () => {
  it('signs in as the employee HR created: the session subject IS employees.id', async () => {
    const who = person(['hr']);
    const created = await createEmployee(who.email!);

    const { cookie } = await microsoftSignIn(who);

    expect(cookie, 'the sign-in minted no session').toBeDefined();
    const principal = await me(cookie!);
    expect(principal.status).toBe(200);
    // The whole point of keeping `employees.id = user.id`: every foreign key keeps pointing at this person.
    expect(principal.body.sub).toBe(created.id);

    const [row] = await db.select().from(employees).where(eq(employees.id, created.id));
    expect(row?.entraOid, 'the Entra object id was not recorded on the employee').toBe(who.oid);
  });

  it('reconciles the App Roles into the role assignments, and removes a role Entra no longer asserts', async () => {
    const who = person(['hr']);
    await createEmployee(who.email!);

    const first = await microsoftSignIn(who);
    const asHr = await me(first.cookie!);
    expect(asHr.body.roles).toEqual(['hr']);
    expect(asHr.body.permissions).toContain('workforce.read');

    // Entra now asserts a different role: the next sign-in reconciles to it. HR is gone.
    const second = await microsoftSignIn({ ...who, claims: { roles: ['auditor'] } });
    const asAuditor = await me(second.cookie!);
    expect(asAuditor.body.roles).toEqual(['auditor']);
    expect(asAuditor.body.permissions).not.toContain('workforce.manage');
  });

  it('a token with no App Role is an `employee`', async () => {
    const who = person(undefined);
    await createEmployee(who.email!);

    const { cookie } = await microsoftSignIn(who);

    expect((await me(cookie!)).body.roles).toEqual(['employee']);
  });

  it('provisions an unknown person from the tenant, with employees.id = the session subject', async () => {
    const who = person(['employee']);

    const { cookie } = await microsoftSignIn(who);
    const principal = await me(cookie!);

    expect(principal.status).toBe(200);
    const [row] = await db.select().from(employees).where(eq(employees.email, who.email!));
    expect(row, 'no employee was provisioned').toBeDefined();
    expect(row.id).toBe(principal.body.sub);
    expect(row.entraOid).toBe(who.oid);
  });

  /*
   * THE REFUSALS ASSERT THE REASON, not only the absence of a cookie: "no cookie" is also what a 500 from a
   * broken handler looks like. identity ends a refused callback with a redirect to the error page carrying a
   * stable `?error=` code, and a crash would carry none.
   */
  it('refuses another tenant: redirected with an error, no session', async () => {
    const refused = await microsoftSignIn(person(['admin'], { tid: OTHER_TENANT }));
    expect(refused.cookie, 'a foreign tenant was given a session').toBeUndefined();
    expect(refused.status).toBe(302);
    expect(refused.error).toBe('unable_to_get_user_info');
  });

  it('refuses an address outside qnsc.vn: redirected with an error, no session', async () => {
    const refused = await microsoftSignIn(
      person(['admin'], { email: `outsider.${RUN}@example.com` }),
    );
    expect(refused.cookie, 'an address off the staff domain was given a session').toBeUndefined();
    expect(refused.status).toBe(302);
    expect(refused.error).toBe('unable_to_get_user_info');
  });

  it('refuses a B2B guest of the tenant (allowGuests is false): redirected with an error, no session', async () => {
    // Entra marks a guest with `acct: 1` (or an `idp` that is not the issuer, or `#EXT#` in the UPN)
    const who = person(['employee']);
    const refused = await microsoftSignIn({
      ...who,
      claims: { roles: ['employee'], acct: 1 },
    });
    expect(refused.cookie, 'a guest was given a session').toBeUndefined();
    expect(refused.status).toBe(302);
    expect(refused.error).toBe('unable_to_get_user_info');
  });

  it('refuses an offboarded employee (banned), even though Entra still lets them in', async () => {
    const who = person(['employee']);
    const created = await createEmployee(who.email!);
    const status = await app.inject({
      method: 'PATCH',
      url: `/v1/employees/${created.id}/status`,
      headers: authHeaders(admin),
      payload: { status: 'offboarded' },
    });
    expect(status.statusCode, status.body).toBe(200);

    const refused = await microsoftSignIn(who);

    expect(refused.cookie, 'an offboarded employee was given a session').toBeUndefined();
    expect(refused.status).toBe(302);
    expect(refused.error).toBe('BANNED_USER');
  });

  it('refuses an offboarded employee even if nothing banned the user: the sign-in hook is the second check', async () => {
    const who = person(['employee']);
    const created = await createEmployee(who.email!);
    // The two rows out of step, however it happened (a failed clear, a hand edit, a restore): the employee
    // is offboarded and the identity user is not banned.
    await db.update(employees).set({ status: 'offboarded' }).where(eq(employees.id, created.id));
    await db.update(identityUser).set({ banned: false }).where(eq(identityUser.id, created.id));

    let refused: Awaited<ReturnType<typeof microsoftSignIn>>;
    try {
      refused = await microsoftSignIn(who);
    } finally {
      // leave the database consistent for the suites that assert the invariant (offboarded => banned)
      await db.update(identityUser).set({ banned: true }).where(eq(identityUser.id, created.id));
    }

    expect(refused.cookie, 'a leaver signed in because only the ban was checked').toBeUndefined();
    expect(refused.status).toBe(302);
    expect(refused.error).toBe('STAFF_SIGN_IN_REFUSED');
  });
});

/*
 * THE ACCESS MODEL (owner decision). "Assignment required" is OFF on the Entra app because the whole company
 * uses OpsHub, so just-in-time provisioning IS the access path:
 *   - any member of the tenant with a qnsc.vn address signs in and is provisioned as `employee`;
 *   - elevated roles come ONLY from Entra App Role assignments, reconciled on every sign-in;
 *   - opshub itself refuses guests, other tenants, other domains and offboarded employees.
 */
describe('the access model', () => {
  async function provisioned(email: string): Promise<{ employee: boolean; user: boolean }> {
    const [e] = await db
      .select({ id: employees.id })
      .from(employees)
      .where(eq(employees.email, email));
    const [u] = await db
      .select({ id: identityUser.id })
      .from(identityUser)
      .where(eq(identityUser.email, email));
    return { employee: Boolean(e), user: Boolean(u) };
  }

  describe('(a) just-in-time access never grants more than `employee` without a role claim', () => {
    it('a newcomer with NO roles claim holds `employee` and no permission at all', async () => {
      const who = person(undefined);

      const { cookie } = await microsoftSignIn(who);

      const principal = await me(cookie!);
      expect(principal.status).toBe(200);
      expect(principal.body.roles).toEqual(['employee']);
      expect(principal.body.permissions, 'JIT granted a permission with no role claim').toEqual([]);
    });

    it('only roles opshub has never heard of are no claim either: `employee`, not nothing and not more', async () => {
      const who = person(['SuperUser', 'Global Administrator']);

      const { cookie } = await microsoftSignIn(who);

      const principal = await me(cookie!);
      expect(principal.body.roles).toEqual(['employee']);
      expect(principal.body.permissions).toEqual([]);
    });

    it('a roles claim that is not a list grants nothing: `employee`', async () => {
      const who = { ...person(undefined), claims: { roles: 'admin' } };

      const { cookie } = await microsoftSignIn(who);

      expect((await me(cookie!)).body.roles).toEqual(['employee']);
    });
  });

  describe('(b) an offboarded employee is refused even when their identity user is gone', () => {
    /**
     * These tests break the employee/user invariant ON PURPOSE, and the refused sign-ins leave behind the NEW
     * user Better Auth made. Put the database back as the invariant suite (`identity-v8-data`) expects it: drop
     * the stray user, restore the employee's own with the same id.
     */
    async function restoreUser(employeeId: string): Promise<void> {
      const [emp] = await db.select().from(employees).where(eq(employees.id, employeeId));
      if (!emp) return;
      await db.delete(identityUser).where(eq(identityUser.email, emp.email.toLowerCase()));
      await db
        .insert(identityUser)
        .values({
          id: emp.id,
          name: emp.displayName,
          email: emp.email.toLowerCase(),
          emailVerified: true,
          banned: emp.status === 'offboarded',
        })
        .onConflictDoNothing();
    }

    const touched: string[] = [];
    afterEach(async () => {
      for (const id of touched.splice(0)) await restoreUser(id);
    });

    async function offboardedEmployee(who: IdpIdentity) {
      const created = await createEmployee(who.email!);
      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/employees/${created.id}/status`,
        headers: authHeaders(admin),
        payload: { status: 'offboarded' },
      });
      expect(res.statusCode, res.body).toBe(200);
      touched.push(created.id);
      return created;
    }

    it('the identity.user row was DELETED: the returning leaver gets a fresh user, and is refused by email', async () => {
      const who = person(['employee']);
      const created = await offboardedEmployee(who);
      await db.delete(identityUser).where(eq(identityUser.id, created.id));

      const refused = await microsoftSignIn(who);

      expect(refused.cookie, 'a leaver signed in because their user row was gone').toBeUndefined();
      expect(refused.error).toBe('STAFF_SIGN_IN_REFUSED');
      const [row] = await db.select().from(employees).where(eq(employees.id, created.id));
      expect(row?.status, 'the refusal must not touch the employee').toBe('offboarded');
    });

    it('never backfilled, matched by the Entra oid alone (their address changed since)', async () => {
      const who = person(['employee']);
      const created = await offboardedEmployee(who);
      await db.update(employees).set({ entraOid: who.oid }).where(eq(employees.id, created.id));
      await db.delete(identityUser).where(eq(identityUser.id, created.id));

      const refused = await microsoftSignIn({
        ...who,
        email: `renamed.${RUN}.${seq}@qnsc.vn`,
      });

      expect(refused.cookie, 'a leaver signed in under a new address').toBeUndefined();
      expect(refused.error).toBe('STAFF_SIGN_IN_REFUSED');
    });

    it('an ACTIVE employee whose user row is gone fails closed too, rather than get a second identity', async () => {
      const who = person(['employee']);
      const created = await createEmployee(who.email!);
      touched.push(created.id);
      await db.delete(identityUser).where(eq(identityUser.id, created.id));

      const refused = await microsoftSignIn(who);

      expect(refused.cookie).toBeUndefined();
      expect(refused.error).toBe('STAFF_SIGN_IN_REFUSED');
      // and no second employee row was made for the same person
      const rows = await db.select().from(employees).where(eq(employees.email, who.email!));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe(created.id);
    });
  });

  describe('(c) guests and other domains are refused BEFORE anything is provisioned', () => {
    it.each([
      ['acct = 1', { acct: 1 }],
      ['#EXT# in the UPN', { upn: 'jane_gmail.com#EXT#@qnsc.onmicrosoft.com' }],
      ['an idp that is not the issuer', { idp: 'https://sts.windows.net/some-other-tenant/' }],
    ])('a guest marked by %s', async (_label, marker) => {
      const who = person(['admin']);

      const refused = await microsoftSignIn({ ...who, claims: { roles: ['admin'], ...marker } });

      expect(refused.cookie, 'a guest was given a session').toBeUndefined();
      expect(refused.error).toBe('unable_to_get_user_info');
      expect(await provisioned(who.email!), 'a refused guest was provisioned').toEqual({
        employee: false,
        user: false,
      });
    });

    it.each(['jane@gmail.com', 'jane@qnsc.vn.evil.example', 'jane@evilqnsc.vn'])(
      'an address off qnsc.vn: %s',
      async (address) => {
        const email = `${RUN}.${address}`;
        const who = person(['admin'], { email });

        const refused = await microsoftSignIn(who);

        expect(
          refused.cookie,
          'an address off the staff domain was given a session',
        ).toBeUndefined();
        expect(refused.error).toBe('unable_to_get_user_info');
        expect(await provisioned(email)).toEqual({ employee: false, user: false });
      },
    );

    it('a SUBDOMAIN of qnsc.vn: identity’s own domain match lets it through, so the sign-in hook is what refuses it', async () => {
      // Found by writing this suite: `staff.domains` matches subdomains, so identity accepts
      // jane@sub.qnsc.vn and creates a user for it. The hook's exact-domain check stops it before any
      // employee, role or session exists.
      const email = `${RUN}.jane@sub.qnsc.vn`;
      const who = person(['admin'], { email });

      const refused = await microsoftSignIn(who);

      expect(refused.cookie, 'a subdomain address was given a session').toBeUndefined();
      expect(refused.error).toBe('STAFF_SIGN_IN_REFUSED');
      expect((await provisioned(email)).employee, 'a subdomain address was provisioned').toBe(
        false,
      );
    });

    it('another tenant is refused before provisioning too', async () => {
      const who = person(['admin'], { tid: OTHER_TENANT });

      const refused = await microsoftSignIn(who);

      expect(refused.cookie).toBeUndefined();
      expect(await provisioned(who.email!)).toEqual({ employee: false, user: false });
    });
  });

  describe('(d) roles are re-synced from the claim on every sign-in', () => {
    it('removing an App Role in Entra demotes the person at their next sign-in, ALL their sessions at once', async () => {
      const who = person(['admin']);

      const first = await microsoftSignIn(who);
      const asAdmin = await me(first.cookie!);
      expect(asAdmin.body.roles).toEqual(['admin']);
      expect(asAdmin.body.permissions).toContain('*');

      // The assignment is removed in Entra. NOTHING changes for the session already open: the sync runs at
      // sign-in, and a session carries no role. This is the window the PR body states.
      const stillAdmin = await me(first.cookie!);
      expect(stillAdmin.body.permissions, 'demoted without a sign-in').toContain('*');

      // Their next sign-in carries no role: demoted to `employee`...
      const second = await microsoftSignIn({ ...who, claims: {} });
      const demoted = await me(second.cookie!);
      expect(demoted.body.roles).toEqual(['employee']);
      expect(demoted.body.permissions).toEqual([]);

      // ...and, because roles live in the database and not in the session, the OLD session is demoted too
      const oldSession = await me(first.cookie!);
      expect(oldSession.status).toBe(200);
      expect(oldSession.body.roles).toEqual(['employee']);
      expect(oldSession.body.permissions, 'the old admin session kept admin rights').toEqual([]);
    });

    it('promotes at the next sign-in too, and a role HR assigned by hand in OpsHub is not Entra’s to keep', async () => {
      const who = person(undefined);
      const first = await microsoftSignIn(who);
      expect((await me(first.cookie!)).body.roles).toEqual(['employee']);

      const promoted = await microsoftSignIn({ ...who, claims: { roles: ['hr'] } });
      expect((await me(promoted.cookie!)).body.roles).toEqual(['hr']);
    });
  });
});
