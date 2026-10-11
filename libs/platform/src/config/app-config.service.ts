import { Injectable } from '@nestjs/common';
import { TypedConfigService } from '@quynhonsemiconductor/platform-runtime';
import type { ApiEnv, Env, WorkerEnv } from './env.schema';

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

/**
 * The API's view of the environment: the common variables PLUS the sign-in secret. The type is the
 * boundary — `get('GRAPH_CLIENT_ID')` does not compile here, and the API's schema refuses to start with
 * a Graph variable set.
 */
@Injectable()
export class ApiConfigService extends TypedConfigService<ApiEnv> {}

/**
 * The worker's view: the common variables PLUS Graph's. `get('ENTRA_CLIENT_SECRET')` does not compile
 * here, and the worker's schema refuses to start with it set.
 */
@Injectable()
export class WorkerConfigService extends TypedConfigService<WorkerEnv> {}
