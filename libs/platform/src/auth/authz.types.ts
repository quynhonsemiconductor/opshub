/**
 * Authorization domain types shared by the enforcement layer (PolicyGuard,
 * AuthzService, ScopeEvaluator) and the authz management module.
 */
import type { JwtPayload } from './principal';

/** Scope dimensions a role assignment can be constrained to. */
export type ScopeType = 'global' | 'self' | 'team' | 'dept' | 'region';

/** A concrete scope grant attached to an effective permission. */
export interface Scope {
  type: ScopeType;
  /** Identifier of the team/dept/region; null for global/self. */
  id: string | null;
}

/**
 * Attributes of the resource a guarded route acts on, used to evaluate scoped
 * grants. Populated from the route's `@RequirePermission` scope descriptor.
 *
 * What the schema can actually supply today:
 *   - `ownerId` — everywhere an owning employee is recorded (`employees.id`,
 *     `assets.assigned_to`, `workforce.*.employee_id`).
 *   - `deptId`  — from `employees.department`, which is a NAME, not a foreign key.
 *     A `dept`-scoped grant therefore stores that same name in `scope_id`.
 *   - `teamId` / `region` — nothing in the schema produces these. There is no teams
 *     table and no region column, so a grant scoped to them can never be satisfied.
 *     {@link AuthzAdminService} refuses to mint one for that reason.
 */
export interface ResourceAttrs {
  ownerId?: string;
  teamId?: string;
  deptId?: string;
  region?: string;
}

/** Where a scope value is read from on the request. */
export type ScopeSource = 'param' | 'query' | 'body';

/**
 * Resource kinds whose owning attributes the guard can resolve by LOADING the row,
 * for routes where the request carries the resource's own id and nothing else.
 */
export type ScopedResource =
  | 'employee'
  | 'asset'
  | 'timesheet'
  | 'leave_request'
  | 'wfh_request'
  | 'overtime'
  | 'door_card'
  | 'door_terminal';

/**
 * How a route tells the guard which resource it is acting on — DECLARATIVELY, so
 * the scope of every route can be read (and audited) without executing anything.
 *
 * Two shapes:
 *   - `{ from, field, as }`      the request already carries the attribute, e.g.
 *                                `?employeeId=…` IS the owner.
 *   - `{ resource, from, field }` the request carries the resource's id; load it
 *                                and derive its attributes.
 *
 * This replaced a `scopeFrom: (req) => ResourceAttrs` callback. The callback was
 * strictly more powerful and never used once — and a per-route closure cannot be
 * checked, listed, or reviewed in bulk, which is exactly what an authorization
 * surface needs.
 */
export type PolicyScope =
  | { from: ScopeSource; field: string; as: keyof ResourceAttrs }
  | { resource: ScopedResource; from: ScopeSource; field: string };

/** permissionKey → scopes in which the principal holds it. */
export type EffectivePermissions = Record<string, Scope[]>;

/**
 * Wildcard permission key — re-exported from the catalogue rather than declared,
 * so there is exactly one `'*'` literal in the codebase. This module used to
 * define its own copy.
 */
export { WILDCARD_PERMISSION } from '@shared-kernel';

export interface Permission {
  key: string;
  description: string;
}

export interface Role {
  id: string;
  key: string;
  name: string;
  system: boolean;
  updatedAt: Date;
}

export interface RoleWithPermissions extends Role {
  permissions: string[];
}

export interface RoleAssignment {
  id: string;
  userId: string;
  roleId: string;
  scopeType: ScopeType;
  scopeId: string | null;
  grantedBy: string;
  expiresAt: Date | null;
  createdAt: Date;
}

/** Re-export for guard/decorator consumers that resolve the principal. */
export type { JwtPayload };
