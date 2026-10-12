import { describe, expect, it, vi } from 'vitest';
import type { SecurityEvent } from '@quynhonsemiconductor/identity';
import { AUDIT_ACTION } from '@modules/audit';
import { SecurityEventAuditSink, auditActionFor } from './security-events.audit';

const event = (over: Partial<SecurityEvent> & { name: SecurityEvent['name'] }): SecurityEvent => ({
  ...over,
});

describe('auditActionFor', () => {
  it('maps a successful sign-in and a failed one to their audit actions', () => {
    expect(auditActionFor(event({ name: 'sign_in.success' }))).toBe(AUDIT_ACTION.AUTH_LOGIN_SSO);
    expect(auditActionFor(event({ name: 'sign_in.failure' }))).toBe('auth.login.failed');
  });

  it.each(['sessions.revoked', 'admin.user_banned'] as const)(
    'does not audit %s: offboarding already records it with the approver as actor',
    (name) => {
      expect(auditActionFor(event({ name }))).toBeUndefined();
    },
  );
});

describe('SecurityEventAuditSink', () => {
  it('records a failed sign-in with ids and the IP only, never an address or a token', async () => {
    const record = vi.fn().mockResolvedValue(undefined);
    const sink = new SecurityEventAuditSink({ record } as never);

    await sink.emit(
      event({ name: 'sign_in.failure', userId: 'user-1', ip: '203.0.113.9' } as never),
    );

    expect(record).toHaveBeenCalledTimes(1);
    const entry = record.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(entry).toMatchObject({
      action: 'auth.login.failed',
      actorId: 'user-1',
      actorEmail: null,
      resourceId: 'user-1',
      metadata: { ipAddress: '203.0.113.9' },
    });
  });

  it('writes nothing for an event that is not audit material', async () => {
    const record = vi.fn();
    const sink = new SecurityEventAuditSink({ record } as never);

    await sink.emit(event({ name: 'admin.user_banned' }));

    expect(record).not.toHaveBeenCalled();
  });
});
