/**
 * The account task is LEVEL-TRIGGERED: it reads the employee's status now and sets the Entra account to
 * match. The tests that matter are the ones a "set enabled = true" payload would fail.
 */
import { describe, expect, it, vi } from 'vitest';
import { NonRetryableError } from '@platform';
import { EntraAccountService } from './entra-account.service';

const OID = '11111111-2222-3333-4444-555555555555';

function make(employee: { status: string; entraOid: string | null } | undefined) {
  const patch = vi.fn().mockResolvedValue(undefined);
  const post = vi.fn().mockResolvedValue(undefined);
  const api = vi.fn((url: string) => ({
    patch: (b: unknown): Promise<void> => patch(url, b) as Promise<void>,
    post: (b: unknown): Promise<void> => post(url, b) as Promise<void>,
  }));
  const graph = { client: () => ({ api }) };
  const select = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(employee ? [employee] : []),
  };
  const db = { select: vi.fn().mockReturnValue(select) };
  return { service: new EntraAccountService(graph as never, db as never), patch, post };
}

describe('EntraAccountService.reconcile', () => {
  it('A STALE ENABLE CAN NEVER RE-ENABLE AN OFFBOARDED ACCOUNT', async () => {
    /*
     * The race a payload-carried "enabled: true" loses: onboarding is approved (a task queued with
     * enabled = true), the person is then offboarded before the worker runs it. The task that runs finds
     * the employee OFFBOARDED, because it reads the row and not its payload — and disables.
     */
    const { service, patch } = make({ status: 'offboarded', entraOid: OID });

    await service.reconcile('emp-1'); // the task that was queued as "onboarding"

    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenCalledWith(`/users/${OID}`, { accountEnabled: false });
    expect(patch).not.toHaveBeenCalledWith(expect.anything(), { accountEnabled: true });
  });

  it('disables an offboarded account AND revokes its sessions, in that order', async () => {
    const { service, patch, post } = make({ status: 'offboarded', entraOid: OID });

    await service.reconcile('emp-1');

    expect(patch).toHaveBeenCalledWith(`/users/${OID}`, { accountEnabled: false });
    expect(post).toHaveBeenCalledWith(`/users/${OID}/revokeSignInSessions`, {});
    expect(patch.mock.invocationCallOrder[0]).toBeLessThan(post.mock.invocationCallOrder[0]);
  });

  it.each(['active', 'on_leave'])(
    'enables a %s employee and does not touch their sessions',
    async (status) => {
      const { service, patch, post } = make({ status, entraOid: OID });

      await service.reconcile('emp-1');

      expect(patch).toHaveBeenCalledWith(`/users/${OID}`, { accountEnabled: true });
      expect(post).not.toHaveBeenCalled();
    },
  );

  it('does nothing for an employee with no Entra OID, or who no longer exists', async () => {
    const noOid = make({ status: 'offboarded', entraOid: null });
    await noOid.service.reconcile('emp-1');
    const gone = make(undefined);
    await gone.service.reconcile('emp-2');

    expect(noOid.patch).not.toHaveBeenCalled();
    expect(gone.patch).not.toHaveBeenCalled();
  });

  it.each(['../me', 'not-a-guid', `${OID}/memberOf`, '1234'])(
    'refuses to build a Graph URL from entra_oid %j (not a GUID) and does not retry',
    async (bad) => {
      const { service, patch } = make({ status: 'offboarded', entraOid: bad });

      await expect(service.reconcile('emp-1')).rejects.toBeInstanceOf(NonRetryableError);
      expect(patch).not.toHaveBeenCalled();
    },
  );

  it('URL-encodes the object id in the path', async () => {
    const { service } = make({ status: 'active', entraOid: OID });
    const spy = vi.spyOn(service, 'setEnabled');

    await service.reconcile('emp-1');

    expect(spy).toHaveBeenCalledWith(OID, true);
  });
});
