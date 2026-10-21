import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetProcessRoleForTests, setProcessRole } from '@platform/config/process-role';
import { EmailRelayService } from './email-relay.service';

/**
 * ONLY THE WORKER SENDS. The API writes outbox rows and notifies; it holds no mail credential. A relay pass in the API
 * would try to send with none.
 */
function relay() {
  const assertReady = vi.fn();
  const service = new EmailRelayService({} as never, { assertReady } as never);
  return { service, assertReady };
}

describe('EmailRelayService per process role', () => {
  afterEach(() => {
    resetProcessRoleForTests();
    setProcessRole('api'); // test/setup.ts's default
  });

  it('the worker checks its transport at start', () => {
    setProcessRole('worker');
    const { service, assertReady } = relay();
    service.onModuleInit();
    expect(assertReady).toHaveBeenCalledOnce();
  });

  it('a transport that cannot work stops the worker at start', () => {
    setProcessRole('worker');
    const { service, assertReady } = relay();
    assertReady.mockImplementation(() => {
      throw new Error('AZURE_CLIENT_ID is required for MAIL_TRANSPORT=graph');
    });
    expect(() => service.onModuleInit()).toThrow(/AZURE_CLIENT_ID/);
  });

  it('the API does not check its transport: it never sends', () => {
    setProcessRole('api');
    const { service, assertReady } = relay();
    service.onModuleInit();
    expect(assertReady).not.toHaveBeenCalled();
  });

  it('relay() does nothing in the API even if something calls it (it must not claim a row it cannot send)', async () => {
    setProcessRole('api');
    // A db that fails loudly if the relay touches it.
    const db = new Proxy(
      {},
      {
        get: () => () => {
          throw new Error('the API claimed an email row');
        },
      },
    );
    const service = new EmailRelayService(db as never, { assertReady: vi.fn() } as never);
    await expect(service.relay()).resolves.toBeUndefined();
  });
});
