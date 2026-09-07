import { Injectable } from '@nestjs/common';
import type { AuditRecordInput, IAuditService } from '@quynhonsemiconductor/identity';
import { AuditService, type AuditAction, type AuditResource } from '@modules/audit';

/**
 * opshub binding for the shared `IAuditService` port. Bridges the package's
 * multi-tenant audit shape onto opshub's single-tenant audit log: `workspaceId`
 * and `projectId` are dropped, and transport metadata (`ipAddress`/`userAgent`)
 * is folded into the `metadata` bag since opshub's audit table has no dedicated
 * columns for them.
 *
 * This is also the one place an audit action crosses a package boundary. The package types
 * `action` as a plain `string`, so the values are narrowed to opshub's union here rather than
 * validated — a rejection would lose an auth event, which is the opposite of what an audit
 * trail is for. `identity-audit-actions.spec.ts` reads the package's dist and fails if it
 * emits an action or resource type the catalogue does not declare, so the assertion below is
 * checked against the real dependency instead of trusted.
 */
@Injectable()
export class AuditServiceAdapter implements IAuditService {
  constructor(private readonly audit: AuditService) {}

  async record(input: AuditRecordInput): Promise<void> {
    const metadata: Record<string, unknown> = { ...(input.metadata ?? {}) };
    if (input.ipAddress) {
      metadata.ipAddress = input.ipAddress;
    }
    if (input.userAgent) {
      metadata.userAgent = input.userAgent;
    }

    await this.audit.record({
      actorId: input.actorId ?? null,
      actorEmail: input.actorEmail ?? null,
      action: input.action as AuditAction,
      resourceType: input.resourceType as AuditResource,
      resourceId: input.resourceId ?? null,
      changes: input.changes,
      metadata,
    });
  }
}
