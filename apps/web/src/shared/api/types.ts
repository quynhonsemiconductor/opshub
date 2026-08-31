/**
 * Convenience type aliases over the generated openapi-typescript schema types.
 * Import from here instead of directly using components['schemas']['…'] everywhere.
 */
import type { components, paths } from './generated/api';

export type { components, paths };

// Auth
export type AuthResponse = components['schemas']['AuthResponseDto'];
export type MeResponse = components['schemas']['MeResponseDto'];

// Employees
export type EmployeeResponse = components['schemas']['EmployeeResponseDto'];
export type CreateEmployeeDto = components['schemas']['CreateEmployeeDto'];
export type UpdateEmployeeDto = components['schemas']['UpdateEmployeeDto'];

// Assets
export type AssetResponse = components['schemas']['AssetResponseDto'];
export type AssetAssignmentResponse = components['schemas']['AssetAssignmentResponseDto'];

// Access
export type AccessRequestResponse = components['schemas']['AccessRequestResponseDto'];
export type AccessGrantResponse = components['schemas']['AccessGrantResponseDto'];

// Compliance
export type FindingResponse = components['schemas']['FindingResponseDto'];

// Workforce
export type TimesheetResponse = components['schemas']['TimesheetResponseDto'];
export type CreateTimesheetInput = components['schemas']['CreateTimesheetDto'];
export type LeaveResponse = components['schemas']['LeaveResponseDto'];
export type OvertimeResponse = components['schemas']['OvertimeResponseDto'];
export type ShiftLogResponse = components['schemas']['ShiftLogResponseDto'];

// Workforce status/type literals (previously exported as enums from generated)
export type TimesheetStatus = components['schemas']['TimesheetResponseDto']['status'];
export type LeaveType = components['schemas']['LeaveResponseDto']['leaveType'];
export type LeaveStatus = components['schemas']['LeaveResponseDto']['status'];
export type OvertimeStatus = components['schemas']['OvertimeResponseDto']['status'];
export type ShiftType = components['schemas']['ShiftLogResponseDto']['shiftType'];
export type AccessRequestStatus = components['schemas']['AccessRequestResponseDto']['status'];

// Webhooks
export type WebhookSubscriptionResponse = components['schemas']['WebhookSubscriptionResponseDto'];
export type WebhookDeliveryResponse = components['schemas']['WebhookDeliveryResponseDto'];
export type CreateWebhookSubscriptionDto = components['schemas']['CreateWebhookSubscriptionDto'];

// Onboarding / Offboarding
export type OnboardingResponse = components['schemas']['OnboardingResponseDto'];
export type OffboardingResponse = components['schemas']['OffboardingResponseDto'];

// Roles / Permissions / Delegations
export type RoleResponse = components['schemas']['RoleResponseDto'];
export type PermissionResponse = components['schemas']['PermissionResponseDto'];
export type RoleAssignmentResponse = components['schemas']['RoleAssignmentResponseDto'];
export type DelegationResponse = components['schemas']['DelegationResponseDto'];

// Positions — the HISTORY shape carries the role it refers to, unlike the plain assignment dto.
export type EmployeePositionHistory = components['schemas']['EmployeePositionHistoryResponseDto'];
export type ContractResponse = components['schemas']['ContractResponseDto'];

/*
 * Compliance — DERIVED from the response DTOs, not hand-written.
 *
 * `SoftwareListing` used to be typed by hand and included a fourth value, `unknown`, that
 * `software_listing` has never had: the enum is whitelisted/blacklisted/review, and the column is
 * NOT NULL with a `review` default. So `unknown` could never arrive from the API and could never be
 * accepted by it — while the catalogue tab offered it as a filter (422) and the reclassify modal
 * offered it as a choice, where picking it failed the save.
 *
 * Hand-writing a union that mirrors a server enum is the whole defect: it compiles whatever you type.
 * These now index into the generated schema, so a value the API does not have is a compile error and
 * a value it GAINS appears here without anybody editing this file.
 */
export type SoftwareResponse = components['schemas']['SoftwareResponseDto'];
export type SoftwareListing = SoftwareResponse['listing'];
export type FindingSeverity = FindingResponse['severity'];
export type FindingStatus = FindingResponse['status'];

// Unified requests inbox
export type RequestItemResponse = components['schemas']['RequestItemResponseDto'];
export type RequestApprovalResponse = components['schemas']['RequestApprovalResponseDto'];
export type RequestCommentResponse = components['schemas']['RequestCommentResponseDto'];
export type RequestStatus =
  'pending' | 'in_review' | 'approved' | 'rejected' | 'cancelled' | 'expired';
export type RequestPriority = 'low' | 'normal' | 'high' | 'urgent';

// Audit logs
export type AuditLogResponse = components['schemas']['AuditLogResponseDto'];

/**
 * Audit resource types — the vocabulary `GET /v1/audit-logs?resourceType=` accepts.
 *
 * WHY THIS LIST EXISTS AT ALL, given the generated client already has the union: a `<Select>` needs the
 * VALUES at run time, and the generated file carries types only. So this is the one place the SPA
 * restates a server vocabulary — and the two assertions below make a drift a COMPILE error rather than
 * a filter that silently matches nothing.
 *
 * `satisfies` catches a value the API does not accept. `_NoMissingAuditResource` catches the opposite,
 * which is the direction a plain `satisfies` cannot see: a resource added to the catalogue and missing
 * here would just be un-filterable, quietly, forever.
 */
export type AuditResourceType = NonNullable<
  NonNullable<paths['/v1/audit-logs']['get']['parameters']['query']>['resourceType']
>;

export const AUDIT_RESOURCE_TYPES = [
  'access_grant',
  'access_request',
  'asset',
  'asset_photo',
  'capa',
  'catalog_item',
  'catalog_request',
  'compliance',
  'compliance_finding',
  'control',
  'delegation',
  'document',
  'document_version',
  'employee',
  'employee_avatar',
  'employee_position',
  'employment_contract',
  'holiday',
  'incident',
  'information_asset',
  'internal_audit',
  'leave_document',
  'leave_entitlement',
  'leave_request',
  'license_assignment',
  'management_review',
  'nonconformance',
  'overtime_entry',
  'performance_cycle',
  'performance_review',
  'position',
  'request',
  'review_action',
  'risk',
  'risk_treatment',
  'role',
  'role_assignment',
  'session',
  'shift_log',
  'soa_entry',
  'software_catalog',
  'software_license',
  'timesheet',
  'training_course',
  'training_record',
  'training_requirement',
  'user',
  'vendor',
  'webhook_delivery',
  'webhook_subscription',
] as const satisfies readonly AuditResourceType[];

/** Compile-time exhaustiveness: a catalogue value absent from the list above fails here. */
type _NoMissingAuditResource =
  Exclude<AuditResourceType, (typeof AUDIT_RESOURCE_TYPES)[number]> extends never ? true : never;
/** Referenced so the alias is not reported as unused; the check is the type, not the value. */
export const AUDIT_RESOURCE_TYPES_ARE_EXHAUSTIVE: _NoMissingAuditResource = true;

// Notifications — not fully typed in generated schema, defined manually
export interface InAppNotification {
  id: string;
  type: string;
  title: string;
  body: string | null;
  resourceType: string | null;
  resourceId: string | null;
  isRead: boolean;
  readAt: string | null;
  createdAt: string;
}
export interface NotificationListResult {
  items: InAppNotification[];
  nextCursor: string | null;
}

// Reports
export type RequestSummaryResponse = components['schemas']['RequestSummaryResponseDto'];
export type CycleTimeResponse = components['schemas']['CycleTimeResponseDto'];
export type SlaComplianceResponse = components['schemas']['SlaComplianceResponseDto'];
export type QueueDepthResponse = components['schemas']['QueueDepthResponseDto'];
export type ThroughputResponse = components['schemas']['ThroughputResponseDto'];
export type FindingsSummaryResponse = components['schemas']['FindingsSummaryResponseDto'];
export type AssetUtilizationResponse = components['schemas']['AssetUtilizationResponseDto'];
export type LeaveSummaryResponse = components['schemas']['LeaveSummaryResponseDto'];
export type OvertimeSummaryResponse = components['schemas']['OvertimeSummaryResponseDto'];

// Notification preferences
export type NotificationPreferenceResponse = components['schemas']['PreferenceResponseDto'];
