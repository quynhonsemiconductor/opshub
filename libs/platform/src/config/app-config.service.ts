import { Injectable } from '@nestjs/common';
import { TypedConfigService } from '@quynhonsemiconductor/platform-runtime';
import type { Env } from './env.schema';

/**
 * Typed config access for opshub.
 *
 * The behaviour lives in `@quynhonsemiconductor/platform-runtime`; `Env` cannot,
 * because it is this service's own variable set. Subclassing binds the two: Nest
 * resolves the inherited constructor, so the body stays empty, and the class remains
 * the DI token every call site already injects.
 */
@Injectable()
export class AppConfigService extends TypedConfigService<Env> {}
