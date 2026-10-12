import { Injectable } from '@nestjs/common';
import type { SecurityEvent, SecurityEventSink } from '@quynhonsemiconductor/identity';
import { AUDIT_ACTION, AUDIT_RESOURCE, AuditService, type AuditAction } from '@modules/audit';

/**
 * Which identity security events are audit-log material, and under which action. Events carry ids, the client
 * address and counts only (never an address, a password or a token), so nothing personal enters the trail.
 *
 * Not every event is here, deliberately:
 *  - `sessions.revoked` and `admin.user_banned` are raised by the service-side revoke that OFFBOARDING calls;
 *    the offboarding workflow and `EmployeeService` already audit that with the approver as the actor
 *    (`session.revoked`), and a second row without an actor would be noise on the record an access review reads;
 *  - password and lockout events belong to presets opshub does not run.
 */
const ACTION_BY_EVENT: Partial<Record<SecurityEvent['name'], AuditAction>> = {
  'sign_in.success': AUDIT_ACTION.AUTH_LOGIN_SSO,
  'sign_in.failure': AUDIT_ACTION.AUTH_LOGIN_FAILED,
};

export function auditActionFor(event: SecurityEvent): AuditAction | undefined {
  return ACTION_BY_EVENT[event.name];
}

/** Identity's `events` sink, writing the sign-in events to opshub's audit log. */
@Injectable()
export class SecurityEventAuditSink implements SecurityEventSink {
  constructor(private readonly audit: AuditService) {}

  async emit(event: SecurityEvent): Promise<void> {
    const action = auditActionFor(event);
    if (!action) return;
    await this.audit.record({
      actorId: event.userId ?? null,
      actorEmail: null,
      action,
      resourceType: AUDIT_RESOURCE.USER,
      resourceId: event.userId ?? null,
      metadata: { ...(event.ip ? { ipAddress: event.ip } : {}), ...(event.detail ?? {}) },
    });
  }
}
