import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetProcessRoleForTests, setProcessRole } from '@platform/config/process-role';
import { EmailRelayService } from './email-relay.service';

/**
 * ONLY THE WORKER SENDS. The API writes outbox rows and publishes the wake signal; it holds no mail credential. Before, the API subscribed to its
 * own wake signal and ran a relay pass too, which with a provider that needs a credential would try to send with none.
 */
function relay() {
  const unsubscribe = vi.fn(() => Promise.resolve());
  const subscribeEmailRelayWake = vi.fn(() => Promise.resolve(unsubscribe));
  const assertReady = vi.fn();
  const service = new EmailRelayService(
    {} as never,
    { assertReady } as never,
    { subscribeEmailRelayWake } as never,
  );
  return { service, subscribeEmailRelayWake, assertReady, unsubscribe };
}

describe('EmailRelayService per process role', () => {
  afterEach(() => {
    resetProcessRoleForTests();
    setProcessRole('api'); // test/setup.ts's default
  });

  it('the worker checks its transport and listens for the wake signal', async () => {
    setProcessRole('worker');
    const { service, subscribeEmailRelayWake, assertReady } = relay();
    await service.onModuleInit();
    expect(assertReady).toHaveBeenCalledOnce();
    expect(subscribeEmailRelayWake).toHaveBeenCalledOnce();
  });

  it('a transport that cannot work stops the worker at start, before it listens', async () => {
    setProcessRole('worker');
    const { service, subscribeEmailRelayWake, assertReady } = relay();
    assertReady.mockImplementation(() => {
      throw new Error('AZURE_CLIENT_ID is required for MAIL_TRANSPORT=graph');
    });
    await expect(service.onModuleInit()).rejects.toThrow(/AZURE_CLIENT_ID/);
    expect(subscribeEmailRelayWake).not.toHaveBeenCalled();
  });

  it('the API neither listens nor checks: it never sends', async () => {
    setProcessRole('api');
    const { service, subscribeEmailRelayWake, assertReady } = relay();
    await service.onModuleInit();
    expect(subscribeEmailRelayWake).not.toHaveBeenCalled();
    expect(assertReady).not.toHaveBeenCalled();
    await expect(service.onModuleDestroy()).resolves.toBeUndefined();
  });
});
