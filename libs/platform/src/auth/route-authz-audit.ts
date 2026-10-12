import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';
import { AUTHZ_MODE_KEY, IS_PUBLIC_KEY, PERMISSION_KEY } from './decorators';

/**
 * Refuse to boot if any HTTP route handler declares no authorization.
 *
 * WHY AT BOOT AND NOT IN THE GUARD
 * --------------------------------
 * `PolicyGuard` also denies an undeclared route now, but it can only do that where it is
 * MOUNTED — and the two decorators a forgotten route most likely carries, `@Public()` and a
 * bare class-level `@Auth()`, do not mount it. So a guard-only fix would leave exactly the
 * case it was written for untouched.
 *
 * A boot check has no such blind spot: it reads every controller's metadata directly, so the
 * question is not "did the guard run" but "did anyone decide". And it fails at deploy time
 * rather than when a caller probes the endpoint, which is the difference between a failed
 * rollout and a quiet data leak.
 *
 * WHAT COUNTS AS DECLARED — one of four, and no default:
 *   `@RequirePermission(code, scope?)`  a permission, checked against the DB
 *   `@Public()`                         no principal exists yet (login, refresh, HMAC webhook)
 *   `@SelfScoped(reason)`               the subject IS the caller
 *   `@AuthorizedInService(reason, test)` resolved at run time, pinned by a named test
 *
 * Class-level metadata counts, because `Reflector.getAllAndOverride` reads handler then class
 * — a controller-wide `@RequirePermission` really does cover its handlers, and reporting them
 * all would be 100 false positives.
 *
 * Deliberately NOT a warning. A warning on a security control is a control that is off: it
 * scrolls past in a deploy log and the endpoint stays open. `test/route-policy.ratchet.spec.ts`
 * is the fast static check for the same property; this is the one that cannot be bypassed by
 * a scanner's regex missing a decorator shape.
 *
 * A LIFECYCLE HOOK, NOT A FUNCTION CALL IN bootstrapApp. Two reasons, both learned the hard
 * way here:
 *   - Controllers are not instantiated until `app.init()`, and `bootstrapApp` runs before it
 *     to register Fastify plugins. Called there, the scan found ZERO routes and the floor
 *     below fired — a check that would have reported "all clear" without that floor.
 *   - As a hook it runs for EVERY application that imports PlatformModule, including the e2e
 *     harness, with no call site anyone can forget to add. A security control wired by
 *     convention is the shape of every "declared but not enforced" bug in this repo.
 */
@Injectable()
export class RouteAuthzAudit implements OnApplicationBootstrap {
  constructor(private readonly discovery: DiscoveryService) {}

  onApplicationBootstrap(): void {
    assertEveryRouteDeclaresAuthz(this.discovery);
  }
}

export function assertEveryRouteDeclaresAuthz(discovery: DiscoveryService): void {
  const logger = new Logger('RouteAuthzAudit');
  const scanner = new MetadataScanner();

  const undeclared: string[] = [];
  let routes = 0;

  for (const wrapper of discovery.getControllers()) {
    // `InstanceWrapper.instance` is `any`, so destructuring it spreads that through the
    // whole loop. Narrowed here instead, once.
    const instance: unknown = wrapper.instance;
    const metatype = wrapper.metatype as (new (...args: never[]) => unknown) | undefined;
    if (!instance || typeof instance !== 'object' || !metatype) continue;

    const prototype = Object.getPrototypeOf(instance) as object;
    const classDeclared =
      Reflect.getMetadata(PERMISSION_KEY, metatype) !== undefined ||
      Reflect.getMetadata(AUTHZ_MODE_KEY, metatype) !== undefined ||
      Reflect.getMetadata(IS_PUBLIC_KEY, metatype) !== undefined;

    for (const name of scanner.getAllMethodNames(prototype)) {
      const handler = (prototype as Record<string, unknown>)[name];
      if (typeof handler !== 'function') continue;
      // PATH_METADATA is what @Get/@Post/... set, so its presence is what makes a method a
      // route rather than a helper. Checking the HTTP verb instead would miss nothing but is
      // less direct, and `undefined` is a legitimate path ('' on the root route).
      if (Reflect.getMetadata(PATH_METADATA, handler) === undefined) continue;

      routes++;
      if (classDeclared) continue;
      const declared =
        Reflect.getMetadata(PERMISSION_KEY, handler) !== undefined ||
        Reflect.getMetadata(AUTHZ_MODE_KEY, handler) !== undefined ||
        Reflect.getMetadata(IS_PUBLIC_KEY, handler) !== undefined;
      if (!declared) undeclared.push(`${metatype.name}.${name}`);
    }
  }

  // A scanner that finds NOTHING reports no violations, which is indistinguishable from a fully
  // decorated app — that is the failure this catches, and it is not hypothetical: run from
  // `bootstrapApp` (before `app.init()` instantiates controllers) the scan found zero and
  // reported success while 43 routes were undeclared.
  //
  // The floor is ZERO, not the real route count. A PARTIAL Nest module is legitimate, and a
  // count-based floor cannot tell one from a blind scanner — proven in rally, where a
  // 150-route floor failed an e2e that deliberately builds a 15-controller test module
  // (QNSC-VN/rally#410). The "does the scanner still see the WHOLE surface" question belongs to
  // `test/route-policy.ratchet.spec.ts`, which reads source text and so can assert a real count
  // against every controller in the repo.
  if (routes === 0) {
    throw new Error(
      `RouteAuthzAudit found NO route handlers. The scanner is broken, not the controllers — ` +
        `Nest's DiscoveryService or PATH_METADATA shape has probably changed, or this ran ` +
        `before app.init() instantiated the controllers. Fix the scanner; do not delete this ` +
        `check.`,
    );
  }

  if (undeclared.length > 0) {
    throw new Error(
      `${undeclared.length} route handler(s) declare no authorization:\n` +
        undeclared.map((r) => `  ${r}`).join('\n') +
        `\n\nEvery route needs exactly one of @RequirePermission(...), @Public(), ` +
        `@SelfScoped(reason) or @AuthorizedInService(reason, pinnedBy). Without one, ` +
        `SessionAuthGuard proves who the caller is and nothing checks whether they may.`,
    );
  }

  logger.log(`Route authorization audit passed — ${routes} handlers, all declared`);
}
