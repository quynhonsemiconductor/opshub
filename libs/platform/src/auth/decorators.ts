import {
  SetMetadata,
  applyDecorators,
  UseGuards,
  createParamDecorator,
  ExecutionContext,
} from '@nestjs/common';
import { ApiCookieAuth, ApiResponse } from '@nestjs/swagger';
import { Public as IdentityPublic } from '@quynhonsemiconductor/identity/nest';
import { SessionAuthGuard } from './session-principal.guard';
import { PolicyGuard } from './policy.guard';
import type { JwtPayload } from './principal';
import type { PolicyScope } from './authz.types';
import type { Permission } from '@shared-kernel';

export const IS_PUBLIC_KEY = 'isPublic';
export const PERMISSION_KEY = 'requiredPermission';
export const AUTHZ_MODE_KEY = 'authzMode';

/**
 * How a route is authorized when it carries no permission code.
 *
 * These exist so "no `@RequirePermission`" stops being indistinguishable from "nobody
 * decided". Both modes are real and unavoidable — see the docblocks on the decorators — but
 * both used to be expressed by the ABSENCE of a decorator, which is also what a forgotten
 * one looks like. 43 route handlers were in that state, and `assertEveryRouteDeclaresAuthz`
 * now refuses to boot until every one of them says which it is.
 */
export type AuthzMode =
  /** The subject IS the caller; there is no cross-user access to authorize. */
  | { mode: 'self-scoped'; reason: string }
  /** Decided at run time inside the service, because no static descriptor can express it. */
  | { mode: 'in-service'; reason: string; pinnedBy: string }
  /** Non-user-specific reference data any authenticated caller may read. */
  | { mode: 'shared-read'; reason: string }
  /** A KNOWN missing check, declared so it is visible and counted. */
  | { mode: 'gap'; reason: string };

/** Metadata attached by @RequirePermission and read by the PolicyGuard. */
export interface PermissionRequirement {
  /**
   * Typed against the catalogue, so `'assset.read'` is a compile error rather
   * than a route that fails closed for everyone in production.
   */
  permission: Permission;
  /**
   * Declarative, so every route's scope can be read and audited without running
   * anything. Omit it for a route whose permission is not resource-scoped.
   */
  scope?: PolicyScope;
}

/**
 * Mark a route as unauthenticated.
 *
 * Sets BOTH keys: opshub's own (read by {@link SessionAuthGuard}, the rate limiter and the route audit) and
 * identity's, which its global `SessionGuard` reads. Setting only ours would answer 401 on the health probes
 * before our guard is ever reached.
 */
export const Public = () => applyDecorators(SetMetadata(IS_PUBLIC_KEY, true), IdentityPublic());

/**
 * Extract the authenticated principal from the request.
 * Only use on routes protected by @Auth() or SessionAuthGuard.
 */
export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): JwtPayload => {
  return ctx.switchToHttp().getRequest<{ user: JwtPayload }>().user;
});

// ── Swagger error-response shortcuts ────────────────────────────────────────

type HttpErrorCode = 400 | 401 | 403 | 404 | 409 | 412 | 422 | 429;

const HTTP_ERROR_DESCRIPTIONS: Record<HttpErrorCode, string> = {
  400: 'Bad Request — validation error or malformed input',
  401: 'Unauthorized — missing or invalid authentication',
  403: 'Forbidden — insufficient permissions',
  404: 'Not Found',
  409: 'Conflict — duplicate record or state conflict',
  412: 'Precondition Failed',
  422: 'Unprocessable — business rule violation',
  429: 'Too Many Requests — rate limit exceeded',
};

export const ApiCommonErrors = (...codes: HttpErrorCode[]) =>
  applyDecorators(
    ...codes.map((c) => ApiResponse({ status: c, description: HTTP_ERROR_DESCRIPTIONS[c] })),
  );

/**
 * Authentication ONLY: verify the caller and annotate Swagger. It carries no
 * authorization — a route under `@Auth()` alone is open to every authenticated
 * caller, which is correct only for surfaces that are self-scoped by construction
 * (`/me`, notification preferences) or that run around a session existing.
 *
 * For anything else use `@RequirePermission(...)`, which mounts the `PolicyGuard`.
 * `@Auth()` used to also mount a `RoleGuard` and accept role names; that guard
 * authorized from the JWT `roles` claim — a mint-time snapshot, so a revoked role
 * stayed effective until the token rotated, and it sat beside the DB-resolved
 * permission path as a second, disagreeing source of truth. Both are gone.
 */
export const Auth = () => applyDecorators(UseGuards(SessionAuthGuard), ApiCookieAuth('session'));

/**
 * Require a fine-grained permission (`module.action`), enforced by the PolicyGuard
 * against the principal's DB-resolved effective permissions.
 *
 * `scope` declares WHICH resource the route acts on, so a grant limited to
 * `self`/`dept` can be checked against it:
 *
 *   // the request already carries the owning employee
 *   @RequirePermission('workforce.read', { from: 'query', field: 'employeeId', as: 'ownerId' })
 *
 *   // the request carries the resource id; load it to find its owner
 *   @RequirePermission('asset.write', { resource: 'asset', from: 'param', field: 'id' })
 *
 * Omit `scope` only where the permission genuinely is not resource-scoped (listing
 * the role catalogue, reading global reports). A holder of a `self`- or
 * `dept`-scoped grant is DENIED on a route with no scope, because the constraint
 * cannot be verified there — see AuthzService.check.
 *
 * This replaced a `scopeFrom: (req) => ResourceAttrs` callback that no route ever
 * used: a per-route closure is strictly more powerful and cannot be listed,
 * reviewed in bulk, or checked by a test, which is the opposite of what an
 * authorization surface needs.
 */
export const RequirePermission = (permission: Permission, scope?: PolicyScope) =>
  applyDecorators(
    UseGuards(SessionAuthGuard, PolicyGuard),
    SetMetadata(PERMISSION_KEY, { permission, scope } satisfies PermissionRequirement),
    ApiCookieAuth('session'),
  );

/**
 * Authenticated, and the subject IS the caller — so there is nothing to authorize beyond
 * identity. `/v1/auth/me`, the notification list, a user's own delegations.
 *
 * NOT a way to skip authorization. It is a claim that the handler cannot reach another
 * user's data, and it is only true while the service keys its reads and writes off
 * `user.sub`. A route that gained an `employeeId` parameter would silently stop qualifying,
 * which is why the count of these is ratcheted: `route-policy.ratchet.spec.ts` fails if it
 * grows, so widening this set is a decision someone has to make out loud.
 *
 * The `employee` role holds NO permission codes at all — self-service is expressed by scope,
 * not by a code — so putting `@RequirePermission('workforce.read')` on "file my own leave"
 * would 403 the exact caller it is for. That is why this mode has to exist rather than every
 * route getting a code.
 */
export const SelfScoped = (reason: string) =>
  applyDecorators(
    UseGuards(SessionAuthGuard, PolicyGuard),
    SetMetadata(AUTHZ_MODE_KEY, { mode: 'self-scoped', reason } satisfies AuthzMode),
    ApiCookieAuth('session'),
  );

/**
 * Authorization is resolved at RUN TIME inside the service, because no static descriptor can
 * express it. Two real shapes in this codebase:
 *
 *   - `requests/:id/{approve,reject}` — the required permission comes from the request TYPE
 *     and the current approval STEP, and the check unions the actor with an active delegator
 *     and enforces separation of duties.
 *   - `GET workforce/{timesheets,leave,overtime,shifts}` — the `employeeId` filter is
 *     OPTIONAL. A scope descriptor resolves no resource when it is omitted, and
 *     `AuthzService.check` then denies, which would 403 the self-service case the SPA
 *     actually issues. The service decides the tier first, then applies the filter.
 *
 * `pinnedBy` names the test that asserts BOTH directions. It is required because this mode
 * moves the decision somewhere a reviewer cannot see from the route, so the only thing
 * keeping it honest is a named test — and `route-policy.ratchet.spec.ts` checks that the
 * file it names exists.
 */
export const AuthorizedInService = (reason: string, pinnedBy: string) =>
  applyDecorators(
    UseGuards(SessionAuthGuard, PolicyGuard),
    SetMetadata(AUTHZ_MODE_KEY, { mode: 'in-service', reason, pinnedBy } satisfies AuthzMode),
    ApiCookieAuth('session'),
  );

/**
 * Non-user-specific reference data that any authenticated caller may read — the service
 * catalogue someone picks a request type from.
 *
 * A permission code cannot express this: the `employee` role holds none, so
 * `@RequirePermission('catalog.manage')` would hide the catalogue from everyone who needs to
 * browse it, and inventing `catalog.read` granted to all roles is a code that means
 * "authenticated", which is what this decorator says without the indirection.
 *
 * Only for data with no owner. If a row belongs to someone, it is `@SelfScoped` or it needs a
 * permission.
 */
export const SharedRead = (reason: string) =>
  applyDecorators(
    UseGuards(SessionAuthGuard, PolicyGuard),
    SetMetadata(AUTHZ_MODE_KEY, { mode: 'shared-read', reason } satisfies AuthzMode),
    ApiCookieAuth('session'),
  );

/**
 * A route with a KNOWN missing authorization check, declared so it is counted rather than
 * hidden.
 *
 * This is a debt marker, not a mode. It exists because the alternative was worse: six routes
 * in the request engine and access-request module return ANY user's data to ANY authenticated
 * caller (`where` is built only from optional filters, so with none supplied it is
 * `undefined`), and the correct fix needs a product decision about who may see all requests.
 * Labelling them `@SelfScoped` would have been false, and leaving them undecorated would have
 * kept them indistinguishable from the 37 routes that are fine.
 *
 * `route-policy.ratchet.spec.ts` counts these and the number may only FALL. Adding one is a
 * decision to ship a known hole and must be argued in review.
 */
export const AuthzGap = (reason: string) =>
  applyDecorators(
    UseGuards(SessionAuthGuard, PolicyGuard),
    SetMetadata(AUTHZ_MODE_KEY, { mode: 'gap', reason } satisfies AuthzMode),
    ApiCookieAuth('session'),
  );
