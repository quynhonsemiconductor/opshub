/**
 * The account task is LEVEL-TRIGGERED and IDENTITY-CHECKED: it verifies the directory object is the
 * employee, then sets the account to match the employee's status as it is when the change is made.
 */
import { describe, expect, it, vi } from 'vitest';
import { DeferError, NonRetryableError } from '@platform';
import { MIN_LEASE_TO_MUTATE_MS } from '../graph-task';
import { EntraAccountService } from './entra-account.service';

const OID = '11111111-2222-3333-4444-555555555555';
const EMAIL = 'Ada.Lovelace@example.com';

interface Row {
  status: string;
  entraOid: string | null;
  email: string;
}
/** A lease with plenty of time left. */
const LEASE_OK = () => new Date(Date.now() + 150_000);

const employee = (over: Partial<Row> = {}): Row => ({
  status: 'active',
  entraOid: OID,
  email: EMAIL,
  ...over,
});

/**
 * `reads` are the successive rows the database returns (the task reads the employee twice before an
 * enable); `directory` is what GET /users/{id} answers.
 */
function make(reads: Array<Row | undefined>, directory: Record<string, unknown> = { mail: EMAIL }) {
  const get = vi.fn().mockResolvedValue(directory);
  const patch = vi.fn().mockResolvedValue(undefined);
  const post = vi.fn().mockResolvedValue(undefined);
  const select = vi.fn();
  const api = vi.fn((url: string) => ({
    select: (fields: string[]) => ({ get: () => get(url, fields) as Promise<unknown> }),
    patch: (b: unknown): Promise<void> => patch(url, b) as Promise<void>,
    post: (b: unknown): Promise<void> => post(url, b) as Promise<void>,
  }));
  const graph = { client: () => ({ api }) };
  const limit = vi.fn();
  reads.forEach((r) => limit.mockResolvedValueOnce(r ? [r] : []));
  const chain = { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), limit };
  select.mockReturnValue(chain);
  const db = { select };
  return { service: new EntraAccountService(graph as never, db as never), get, patch, post, limit };
}

describe('EntraAccountService.reconcile — identity check', () => {
  it('reads mail + userPrincipalName of the object before changing anything', async () => {
    const { service, get, patch } = make([employee(), employee()]);

    await service.reconcile('emp-1', LEASE_OK());

    expect(get).toHaveBeenCalledWith(`/users/${OID}`, [
      'id',
      'userPrincipalName',
      'mail',
      'proxyAddresses',
    ]);
    expect(get.mock.invocationCallOrder[0]).toBeLessThan(patch.mock.invocationCallOrder[0]);
  });

  it.each([
    ['mail', { mail: EMAIL.toUpperCase(), userPrincipalName: 'someone.else@example.com' }],
    ['userPrincipalName', { mail: null, userPrincipalName: EMAIL.toLowerCase() }],
  ])(
    'accepts an object whose %s equals the employee email, case-insensitively',
    async (_field, directory) => {
      const { service, patch } = make([employee(), employee()], directory);

      await service.reconcile('emp-1', LEASE_OK());

      expect(patch).toHaveBeenCalledWith(`/users/${OID}`, { accountEnabled: true });
    },
  );

  it("A POINTER AT SOMEONE ELSE'S ACCOUNT IS NEVER TOUCHED: dead-letter, no PATCH, no revoke", async () => {
    /*
     * `employees.entra_oid` can be written through POST /employees by an `employee.write` holder. If it
     * is aimed at another person's object (a CEO, a service account), the offboarding of the employee
     * must not disable THAT account.
     */
    const { service, patch, post } = make([employee({ status: 'offboarded' })], {
      mail: 'ceo@example.com',
      userPrincipalName: 'ceo@example.com',
    });

    await expect(service.reconcile('emp-1', LEASE_OK())).rejects.toBeInstanceOf(NonRetryableError);

    expect(patch).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it('does not put either address in the failure message', async () => {
    const { service } = make([employee()], {
      mail: 'ceo@example.com',
      userPrincipalName: 'ceo@example.com',
    });

    const err = (await service.reconcile('emp-1', LEASE_OK()).catch((e: unknown) => e)) as Error;

    expect(err.message).not.toContain('ceo@example.com');
    expect(err.message).not.toContain(EMAIL);
  });

  it('refuses an entra_oid that is not a GUID without making any call', async () => {
    const { service, get } = make([employee({ entraOid: '../me' })]);

    await expect(service.reconcile('emp-1', LEASE_OK())).rejects.toBeInstanceOf(NonRetryableError);
    expect(get).not.toHaveBeenCalled();
  });
});

describe('EntraAccountService.reconcile — level-triggered', () => {
  it('A STALE ENABLE CAN NEVER RE-ENABLE AN OFFBOARDED ACCOUNT', async () => {
    // The task was queued at onboarding; the person is offboarded before it runs. It reads the row.
    const { service, patch } = make([employee({ status: 'offboarded' })]);

    await service.reconcile('emp-1', LEASE_OK());

    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenCalledWith(`/users/${OID}`, { accountEnabled: false });
  });

  it('RE-READS THE STATUS IMMEDIATELY BEFORE AN ENABLE and skips it if the employee was offboarded meanwhile', async () => {
    // First read: active. By the second read — after the identity check — they are offboarded.
    const { service, patch, post } = make([employee(), employee({ status: 'offboarded' })]);

    await service.reconcile('emp-1', LEASE_OK());

    expect(patch).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it('skips the enable if the employee row vanished meanwhile', async () => {
    const { service, patch } = make([employee(), undefined]);
    await service.reconcile('emp-1', LEASE_OK());
    expect(patch).not.toHaveBeenCalled();
  });

  it('disables an offboarded account AND revokes its sessions, in that order, after the check', async () => {
    const { service, get, patch, post } = make([employee({ status: 'offboarded' })]);

    await service.reconcile('emp-1', LEASE_OK());

    expect(post).toHaveBeenCalledWith(`/users/${OID}/revokeSignInSessions`, {});
    expect(get.mock.invocationCallOrder[0]).toBeLessThan(patch.mock.invocationCallOrder[0]);
    expect(patch.mock.invocationCallOrder[0]).toBeLessThan(post.mock.invocationCallOrder[0]);
  });

  it.each(['active', 'on_leave'])(
    'enables a %s employee and does not touch their sessions',
    async (status) => {
      const { service, patch, post } = make([employee({ status }), employee({ status })]);

      await service.reconcile('emp-1', LEASE_OK());

      expect(patch).toHaveBeenCalledWith(`/users/${OID}`, { accountEnabled: true });
      expect(post).not.toHaveBeenCalled();
    },
  );

  it('does nothing for an employee with no Entra OID, or who no longer exists', async () => {
    const noOid = make([employee({ entraOid: null })]);
    await noOid.service.reconcile('emp-1', LEASE_OK());
    const gone = make([undefined]);
    await gone.service.reconcile('emp-2', LEASE_OK());

    expect(noOid.patch).not.toHaveBeenCalled();
    expect(gone.patch).not.toHaveBeenCalled();
  });

  it('never makes more calls than its declared budget (the lease is derived from it)', async () => {
    const { service, get, patch, post } = make([employee({ status: 'offboarded' })]);

    await service.reconcile('emp-1', LEASE_OK());

    expect(
      get.mock.calls.length + patch.mock.calls.length + post.mock.calls.length,
    ).toBeLessThanOrEqual(3);
  });
});

describe('EntraAccountService.reconcile — alias addresses', () => {
  it.each([
    ['an smtp: alias', ['SMTP:primary@example.com', `smtp:${EMAIL.toLowerCase()}`]],
    ['an SMTP: primary', [`SMTP:${EMAIL}`]],
    ['mixed-case prefixes', [`Smtp:${EMAIL.toUpperCase()}`]],
  ])('accepts an object whose proxyAddresses hold %s', async (_name, proxyAddresses) => {
    const { service, patch } = make([employee(), employee()], {
      mail: 'primary@example.com',
      userPrincipalName: 'primary@example.com',
      proxyAddresses,
    });

    await service.reconcile('emp-1', LEASE_OK());

    expect(patch).toHaveBeenCalledWith(`/users/${OID}`, { accountEnabled: true });
  });

  it('ignores non-smtp proxy addresses (x500, SIP): they are not mailboxes', async () => {
    const { service, patch } = make([employee({ status: 'offboarded' })], {
      mail: 'other@example.com',
      proxyAddresses: [`x500:${EMAIL}`, `SIP:${EMAIL}`],
    });

    await expect(service.reconcile('emp-1', LEASE_OK())).rejects.toBeInstanceOf(NonRetryableError);
    expect(patch).not.toHaveBeenCalled();
  });
});

const NOT_ENOUGH_LEASE = /of lease left/;

describe('EntraAccountService.reconcile — will not START a change it may not finish', () => {
  const nearlyOver = () => new Date(Date.now() + MIN_LEASE_TO_MUTATE_MS - 5_000);

  it('fails as an ordinary RETRYABLE attempt (counted, so it cannot loop for ever) instead of disabling when less than a full call deadline of lease is left', async () => {
    const { service, patch, post } = make([employee({ status: 'offboarded' })]);

    await expect(service.reconcile('emp-1', nearlyOver())).rejects.toThrow(NOT_ENOUGH_LEASE);

    expect(patch).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it('is NOT a DeferError (that refunds the attempt with no limit) and NOT NonRetryable (a fresh lease may be enough)', async () => {
    const { service } = make([employee({ status: 'offboarded' })]);

    const err: unknown = await service.reconcile('emp-1', nearlyOver()).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(DeferError);
    expect(err).not.toBeInstanceOf(NonRetryableError);
  });

  it('fails the same way before an ENABLE', async () => {
    const { service, patch } = make([employee(), employee()]);

    await expect(service.reconcile('emp-1', nearlyOver())).rejects.toThrow(NOT_ENOUGH_LEASE);
    expect(patch).not.toHaveBeenCalled();
  });

  it('re-checks before the SECOND change: a slow disable must not be followed by a revoke that cannot finish', async () => {
    const { service, patch, post } = make([employee({ status: 'offboarded' })]);
    let calls = 0;
    // Plenty of lease for the disable, then (after it) too little for the revoke.
    const lease = {
      getTime: () => (calls++ === 0 ? Date.now() + 150_000 : Date.now() + 5_000),
    } as unknown as Date;

    await expect(service.reconcile('emp-1', lease)).rejects.toThrow(NOT_ENOUGH_LEASE);

    expect(patch).toHaveBeenCalledTimes(1);
    expect(post).not.toHaveBeenCalled();
  });

  it('proceeds when a full call deadline plus the margin remains', async () => {
    const { service, patch } = make([employee({ status: 'offboarded' })]);
    await service.reconcile('emp-1', new Date(Date.now() + MIN_LEASE_TO_MUTATE_MS + 5_000));
    expect(patch).toHaveBeenCalledTimes(1);
  });
});

describe('EntraAccountService — FAILS CLOSED where the write permissions are not granted (develop holds only the three read ones)', () => {
  const forbidden = () => Object.assign(new Error('Insufficient privileges'), { statusCode: 403 });

  it.each([
    ['disable', 'User.EnableDisableAccount.All', 'patch'],
    ['revoke sessions of', 'User.RevokeSessions.All', 'post'],
  ] as const)(
    'a 403 on %s dead-letters at once with one clear log naming %s, and nothing is retried or changed further',
    async (action, permission, call) => {
      const { service, patch, post } = make([employee({ status: 'offboarded' })]);
      (call === 'patch' ? patch : post).mockRejectedValue(forbidden());
      const logged = vi.spyOn(service['logger'], 'error').mockImplementation(() => undefined);

      const error = await service.reconcile('emp-1', LEASE_OK()).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(NonRetryableError);
      expect((error as Error).message).toContain(permission);
      expect(logged).toHaveBeenCalledTimes(1);
      expect(logged.mock.calls[0][0]).toEqual({ permission, entraOid: OID });
      expect(String(logged.mock.calls[0][1])).toContain(`Refused to ${action}`);
      expect(String(logged.mock.calls[0][1])).toContain('Nothing was changed');
      // A disable that is refused must not go on to revoke.
      if (call === 'patch') expect(post).not.toHaveBeenCalled();
    },
  );

  it('leaves any other Graph error to the relay (a 503 is not turned into a permission failure)', async () => {
    const { service, patch } = make([employee({ status: 'offboarded' })]);
    const unavailable = Object.assign(new Error('down'), { statusCode: 503 });
    patch.mockRejectedValue(unavailable);
    await expect(service.reconcile('emp-1', LEASE_OK())).rejects.toBe(unavailable);
  });
});
