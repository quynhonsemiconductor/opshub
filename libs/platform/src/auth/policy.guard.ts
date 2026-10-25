import { CanActivate, ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PermissionDeniedException, UnauthorizedException } from '../errors/exceptions';
import { AuthzService } from './authz.service';
import { ResourceScopeResolver } from './resource-scope.resolver';
import {
  AUTHZ_MODE_KEY,
  PERMISSION_KEY,
  type AuthzMode,
  type PermissionRequirement,
} from './decorators';
import type { PolicyScope, ResourceAttrs } from './authz.types';
import type { JwtPayload } from './principal';

/**
 * Permission guard — enforces the fine-grained permission declared via
 * @RequirePermission(...). Runs after SessionAuthGuard, so request.user is set.
 *
 * DENIES A ROUTE THAT DECLARED NOTHING. This used to `return true` on missing metadata, so a
 * handler nobody decorated was open to every authenticated caller: `SessionAuthGuard` proved who
 * you were and then nothing checked whether you may. 43 handlers were in that state, and a
 * new one was a silently world-readable endpoint that every test still passed.
 *
 * A route that genuinely needs no permission code now says which of the two real reasons
 * applies — `@SelfScoped` or `@AuthorizedInService` — so "no code" and "nobody decided" stop
 * looking identical.
 *
 * THIS IS DEFENCE IN DEPTH, NOT THE PRIMARY GATE. The guard only runs where it is mounted,
 * and `@Public()` / a bare `@Auth()` do not mount it — so a forgotten decorator would never
 * reach this code at all. `assertEveryRouteDeclaresAuthz` is the real enforcement: it refuses
 * to BOOT on an undeclared route, which catches it at deploy rather than when someone probes
 * the endpoint. Resolution is delegated to {@link AuthzService}, which fails closed on
 * cache/DB errors.
 */
@Injectable()
export class PolicyGuard implements CanActivate {
  private readonly logger = new Logger(PolicyGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly authz: AuthzService,
    private readonly scopes: ResourceScopeResolver,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requirement = this.reflector.getAllAndOverride<PermissionRequirement>(PERMISSION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requirement) {
      // An explicitly declared mode needs no permission code. The declaration itself is the
      // authorization decision; the narrowing that makes it true lives in the service.
      const declared = this.reflector.getAllAndOverride<AuthzMode>(AUTHZ_MODE_KEY, [
        context.getHandler(),
        context.getClass(),
      ]);
      if (declared) return true;

      // Nothing declared. Fail closed and name the route, because the alternative is an open
      // endpoint that looks healthy.
      this.logger.error(
        {
          controller: context.getClass().name,
          handler: context.getHandler().name,
        },
        'Route declares no authorization (@RequirePermission / @SelfScoped / ' +
          '@AuthorizedInService / @Public) — denying',
      );
      throw new PermissionDeniedException('Route declares no authorization');
    }

    const req = context.switchToHttp().getRequest<{
      user?: JwtPayload;
      params: Record<string, string>;
      query: Record<string, unknown>;
      body: unknown;
    }>();
    const user = req.user;
    if (!user) throw new UnauthorizedException('UNAUTHORIZED', 'Authentication required');

    const resource = await this.resolveScope(req, requirement.scope);
    const allowed = await this.authz.check(user.sub, requirement.permission, resource, user);
    if (!allowed) {
      throw new PermissionDeniedException(`Missing permission: ${requirement.permission}`);
    }
    return true;
  }

  /**
   * Turn the route's declarative scope into the attributes the evaluator compares
   * against. `undefined` means the route declared no scope — which is NOT the same
   * as "no constraint": AuthzService.check denies a constrained grant it cannot
   * verify.
   *
   * A descriptor whose field is absent from the request also yields `undefined`
   * rather than an empty object, so a missing `?employeeId=` cannot read as
   * "matches nothing in particular" and slip past a `self` grant.
   */
  private async resolveScope(
    req: { params: Record<string, string>; query: Record<string, unknown>; body: unknown },
    scope: PolicyScope | undefined,
  ): Promise<ResourceAttrs | undefined> {
    if (!scope) return undefined;

    const bag =
      scope.from === 'param'
        ? req.params
        : scope.from === 'query'
          ? req.query
          : ((req.body ?? {}) as Record<string, unknown>);
    const raw = bag?.[scope.field];
    const value = typeof raw === 'string' && raw.length > 0 ? raw : undefined;
    if (!value) return undefined;

    return 'resource' in scope ? this.scopes.resolve(scope.resource, value) : { [scope.as]: value };
  }
}
