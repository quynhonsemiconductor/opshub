/**
 * The boot audit must FAIL on an undeclared route, and must fail if it stops finding routes.
 *
 * Both halves matter. The second is not paranoia: the first version of this check ran inside
 * `bootstrapApp`, before `app.init()` instantiated any controller, so it scanned ZERO handlers
 * and reported success while 43 routes were undeclared. Only the route floor caught it.
 *
 * Driven through a fake DiscoveryService rather than a real app: the real one needs a database
 * and a full module graph, and what is under test is the metadata scan, not Nest's wiring
 * (`test/e2e/*` boots the real app, which is what proves the hook is actually installed).
 */
import { Controller, Get, Post } from '@nestjs/common';
import type { DiscoveryService } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { AuthzGap, Public, RequirePermission, SelfScoped } from './decorators';
import { assertEveryRouteDeclaresAuthz } from './route-authz-audit';

/** Enough of DiscoveryService for the scan: the controller wrappers it iterates. */
function discoveryOf(...controllers: (new () => unknown)[]): DiscoveryService {
  return {
    getControllers: () => controllers.map((metatype) => ({ instance: new metatype(), metatype })),
  } as unknown as DiscoveryService;
}

/** A few declared routes, so each case below differs by exactly one handler. */
function paddedController(extra?: (proto: object) => void): new () => unknown {
  @Controller('pad')
  class PadController {}

  const proto = PadController.prototype as unknown as Record<string, unknown>;
  for (let i = 0; i < 3; i++) {
    const name = `route${i}`;
    proto[name] = function handler(this: void) {};
    // Apply real decorators so the metadata is exactly what Nest would set.
    Get(`r${i}`)(proto, name, { value: proto[name] } as PropertyDescriptor);
    SelfScoped('padding — declared')(proto, name, { value: proto[name] });
  }
  extra?.(proto);
  return PadController;
}

describe('assertEveryRouteDeclaresAuthz', () => {
  it('passes when every route declares a mode', () => {
    expect(() => assertEveryRouteDeclaresAuthz(discoveryOf(paddedController()))).not.toThrow();
  });

  it('throws, naming the handler, when a route declares nothing', () => {
    const controller = paddedController((proto) => {
      const p = proto as Record<string, unknown>;
      p['undeclared'] = function undeclared(this: void) {};
      Post('oops')(proto, 'undeclared', { value: p['undeclared'] } as PropertyDescriptor);
    });

    expect(() => assertEveryRouteDeclaresAuthz(discoveryOf(controller))).toThrow(
      /1 route handler\(s\) declare no authorization[\s\S]*undeclared/,
    );
  });

  it('accepts each of the four declaration shapes', () => {
    for (const [name, decorate] of [
      ['permission', RequirePermission('asset.read')],
      ['public', Public()],
      ['self', SelfScoped('the caller')],
      ['gap', AuthzGap('known hole')],
    ] as const) {
      const controller = paddedController((proto) => {
        const p = proto as Record<string, unknown>;
        p[name] = function handler(this: void) {};
        Get(name)(proto, name, { value: p[name] } as PropertyDescriptor);
        (decorate as MethodDecorator)(proto, name, { value: p[name] } as PropertyDescriptor);
      });
      expect(
        () => assertEveryRouteDeclaresAuthz(discoveryOf(controller)),
        `${name} should count as declared`,
      ).not.toThrow();
    }
  });

  it('honours a class-level declaration for every handler in that controller', () => {
    // Reflector.getAllAndOverride reads handler THEN class, so a controller-wide decorator
    // really does cover its routes — reporting them would be a wall of false positives.
    @RequirePermission('audit.read')
    @Controller('all')
    class ClassDeclaredController {}
    const proto = ClassDeclaredController.prototype as unknown as Record<string, unknown>;
    for (let i = 0; i < 3; i++) {
      const name = `route${i}`;
      proto[name] = function handler(this: void) {};
      Get(`r${i}`)(proto, name, { value: proto[name] } as PropertyDescriptor);
    }

    expect(() =>
      assertEveryRouteDeclaresAuthz(
        discoveryOf(ClassDeclaredController as unknown as new () => unknown),
      ),
    ).not.toThrow();
  });

  it('refuses to report success when it finds NO routes', () => {
    @Controller('tiny')
    class TinyController {}
    const proto = TinyController.prototype as unknown as Record<string, unknown>;
    proto['one'] = function one(this: void) {};
    Get('one')(proto, 'one', { value: proto['one'] } as PropertyDescriptor);
    SelfScoped('declared')(proto, 'one', { value: proto['one'] } as PropertyDescriptor);

    // A SMALL module is legitimate — rova has an e2e that builds a 15-controller one — so only
    // an EMPTY scan proves the scanner is broken.
    expect(() =>
      assertEveryRouteDeclaresAuthz(discoveryOf(TinyController as unknown as new () => unknown)),
    ).not.toThrow();

    @Controller('none')
    class NoRoutesController {}
    expect(() =>
      assertEveryRouteDeclaresAuthz(
        discoveryOf(NoRoutesController as unknown as new () => unknown),
      ),
    ).toThrow(/found NO route handlers/);
  });

  it('ignores non-route methods', () => {
    const controller = paddedController((proto) => {
      (proto as Record<string, unknown>)['helper'] = function helper(this: void) {};
    });
    // A helper carries no PATH_METADATA, so it is not a route and needs no declaration.
    expect(() => assertEveryRouteDeclaresAuthz(discoveryOf(controller))).not.toThrow();
  });
});
