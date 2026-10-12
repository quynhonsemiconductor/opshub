import { describe, expect, it } from 'vitest';
import { EMAIL_SEND_TIMEOUT_MS } from '@platform/email';
import { EMAIL_LEASE_MARGIN_MS, EmailRelayService } from './email-relay.service';

describe('EmailRelayService lease', () => {
  it('outlives a provider send by a margin: lease > send timeout + margin', () => {
    /*
     * A send still in flight after the lease lapsed is a send another relay can repeat, and a row the
     * reaper dead-letters while it is still being delivered.
     */
    const relay = new EmailRelayService({} as never, {} as never, {} as never);
    const lease = (relay as unknown as { leaseMsFor(): number }).leaseMsFor();

    expect(lease).toBeGreaterThanOrEqual(EMAIL_SEND_TIMEOUT_MS + EMAIL_LEASE_MARGIN_MS);
    expect(lease).toBeGreaterThan(EMAIL_SEND_TIMEOUT_MS);
  });
});
