import { Inject, Injectable } from '@nestjs/common';
import { BffService } from '@quynhonsemiconductor/identity';
import { type BffSessionResolver, type JwtPayload, toOpshubPrincipal } from '@platform';

/**
 * Binds the shared `@quynhonsemiconductor/identity` {@link BffService} to opshub's
 * {@link BffSessionResolver} contract, which the platform `JwtAuthGuard` consumes.
 *
 * The shared service resolves a session id to the product-neutral core payload; opshub
 * flattens it onto its own request principal with {@link toOpshubPrincipal}, exactly as
 * the Bearer path does. That shared mapping is the point: this is the only product-side
 * seam the BFF needs, and it cannot produce a principal that differs from the Bearer
 * one.
 *
 * The inversion also keeps `libs/platform` free of a dependency on this module — the
 * guard knows a contract, not an implementation.
 */
@Injectable()
export class OpshubBffSessionResolver implements BffSessionResolver {
  constructor(@Inject(BffService) private readonly bff: BffService) {}

  get enabled(): boolean {
    return this.bff.enabled;
  }

  async resolve(sid: string, ip: string): Promise<JwtPayload | null> {
    const core = await this.bff.resolve(sid, ip);
    return core ? toOpshubPrincipal(core) : null;
  }
}
