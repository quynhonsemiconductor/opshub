/**
 * Shared e2e harness: boot the REAL API in-process and drive it over REAL HTTP.
 *
 * Every e2e spec goes through here rather than assembling its own Nest app, for one
 * reason: an app assembled by hand is a DIFFERENT app. Miss `app.register(fastifyCookie)`
 * and the CSRF hook cannot read a cookie, so a spec asserting CSRF protection passes
 * against a server that could never have enforced it. `bootstrapApp` is the same function
 * `apps/api/src/main.ts` calls, so the helmet headers, the cookie plugin, the ONE CSRF
 * `onRequest` hook, CORS and the `/v1` prefix are all present exactly as in production.
 *
 * `app.inject()` rather than a listening socket: the full Fastify lifecycle runs — hooks,
 * guards, interceptors, pipes, filters — with no port to allocate and no race to poll.
 *
 * Nothing is stubbed. Sessions come from identity 8's `POST /api/auth/test-login`, which loads only
 * when `IDENTITY_TEST_LOGIN=enabled` AND `NODE_ENV` is exactly `test` or `development` (identity
 * refuses to boot otherwise), so the specs authenticate as the real seeded fixtures with a real
 * session row, the real session cookie and real permission resolution. The same CSRF token a browser
 * gets from `GET /v1/auth/me` is fetched here, because the cookie is the ONLY credential now and every
 * state-changing request therefore needs it.
 *
 * Prereqs: `docker compose -f docker-compose.dev.yml up -d` and `pnpm db:seed`.
 */
import 'reflect-metadata';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { prepareHttpApp } from '@quynhonsemiconductor/platform-runtime/bootstrap';
import { CacheService } from '@quynhonsemiconductor/platform-cache';
import { CSRF_SECRET_COOKIE, RATE_LIMIT_TIERS, SESSION_COOKIE } from '@platform';
import { apiAppOptions } from '../../../apps/api/src/app-options';

/**
 * Seeded demo employees (`db/seed.ts`), addressed by the tier they represent rather than
 * by name — a spec should read as "the caller who holds nothing", not "employee 8".
 *
 *  - `NO_PERMISSIONS` holds the `employee` role, whose permission bundle is EMPTY by
 *    design: self-service is expressed by scope, not by a permission code.
 *  - `HR` holds `workforce.read` and `workforce.approve` GLOBALLY, so it is the
 *    unconstrained tier every narrowing check has to let through.
 */
export const FIXTURE = {
  NO_PERMISSIONS: {
    id: '00000000-0000-7000-8000-000000000008',
    email: 'employee@opshub.local',
  },
  HR: {
    id: '00000000-0000-7000-8000-000000000004',
    email: 'hr@opshub.local',
  },
  ADMIN: {
    id: '00000000-0000-7000-8000-000000000001',
    email: 'admin@opshub.local',
  },
  /**
   * Holds the READ half of several bundles without the MANAGE half — `position.read` but not
   * `position.manage`, `workforce.read` but not `workforce.manage`.
   *
   * The tier that catches a route guarded by the wrong permission of a pair. `NO_PERMISSIONS`
   * cannot: it is rejected by either code, so a 403 for it proves nothing about WHICH one was
   * required.
   */
  MANAGER: {
    id: '00000000-0000-7000-8000-000000000005',
    email: 'manager@opshub.local',
  },
  /**
   * Read-only across the platform, and the tier for FIELD-LEVEL redaction.
   *
   * Holds `contract.read` but NOT `contract.compensation.read` — deliberately, in the catalogue: an
   * auditor checks that every employee has a signed contract, which does not require knowing what
   * any of them pays. So this fixture is the only one that can prove a field is hidden while the
   * record around it is still visible; `NO_PERMISSIONS` gets a 403 and sees no field either way.
   */
  AUDITOR: {
    id: '00000000-0000-7000-8000-000000000007',
    email: 'auditor@opshub.local',
  },
  /**
   * Holds `documents.manage`, `documents.approve` and `documents.publish` — the ISMS owner, and
   * the AUTHOR in the controlled-document specs. Kept distinct from ADMIN on purpose: separation
   * of duties can only be tested with two identities, since an author may not approve their own
   * policy.
   */
  SECURITY: {
    id: '00000000-0000-7000-8000-000000000003',
    email: 'security@opshub.local',
  },
} as const;

export async function createTestApp(): Promise<NestFastifyApplication> {
  // EXACTLY what production starts (`createHttpApp(apiAppOptions)` minus listening): the role hook, the lazy `AppModule`, the OTel options, the 10 MB
  // body limit, and `configure` (correlation id, then `bootstrapApp`), around the one shared pino logger. The environment is the suite's
  // (`LOG_LEVEL=fatal`). A harness that rebuilt these by hand would test an app that does not ship.
  const app = await prepareHttpApp(apiAppOptions);
  await app.init();
  // Fastify only builds its routing table and runs plugin `onReady` hooks here. Without
  // it `inject()` on a freshly created app can 404 a route that is in fact registered.
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

/**
 * Clear EVERY rate-limit bucket this suite can fill — all tiers, all fixtures, and the IP.
 *
 * The counters live in Valkey, which OUTLIVES the test process, so they accumulate across
 * runs. Two failure modes, both measured rather than predicted:
 *
 *   • The per-address pre-auth bucket (`PRE_AUTH_IP_BUCKET`, 1000 per minute per IP) holds a slot for every request
 *     identity has not verified. Signed-in traffic gives its slot back, so the bucket fills from unverified requests
 *     (401s, forged cookies). The suite
 *     runs serially (see vitest.e2e.config.ts), and the e2e config raises the ceiling for the run.
 *   • `DEFAULT` allows 200 requests per minute per userId. One full suite pass is well over
 *     100 requests as `hr` alone, so a SECOND pass started inside the same minute 429s partway
 *     in, on whichever spec happens to be running. Clearing only the login tier left this half
 *     of the problem in place, and it cost a debugging round today.
 *
 * Per-user tiers come from `RATE_LIMIT_TIERS` rather than a list written out here, so a tier added later is covered
 * without anyone remembering this file. Subjects are the IP (the pre-auth bucket) plus every fixture id, because the
 * per-user buckets key on the user, and `app.inject()` has no socket, so Fastify reports `127.0.0.1` for the address.
 *
 * Goes through the app's own `CacheService.del`, not a raw client, so the namespace prefix
 * and the `rl:` key shape stay in ONE place: `consumeRateLimit` builds the same key, and a
 * hard-coded string here would silently stop matching if either changed.
 */
async function clearRateLimits(app: NestFastifyApplication): Promise<void> {
  const ids = Object.values(FIXTURE).map((f) => f.id);
  try {
    const cache = app.get(CacheService);
    await Promise.all([
      // The pre-auth bucket: one per verified client address (127.0.0.1 under app.inject()).
      cache.del('rl:IP:127.0.0.1'),
      // The per-user buckets: one per tier per fixture user.
      ...Object.keys(RATE_LIMIT_TIERS).flatMap((tier) =>
        ids.map((id) => cache.del(`rl:${tier}:uid:${id}`)),
      ),
    ]);
  } catch {
    // Cache optional in some configurations; the limiter fails open there anyway.
  }
}

/** A test-login result: the session cookie, plus the CSRF half a browser would hold. */
export interface Session {
  /** The signed-in user's id (`identity.user.id` = `identity.employees.id`). */
  userId: string;
  /** The session cookie's `name=value`, alone: what a spec replays to be "logged in". */
  sessionCookie: string;
  /** Session cookie AND CSRF secret cookie, ready for a `cookie` request header. */
  cookieHeader: string;
  /** The token for the `x-csrf-token` header, bound to this session. */
  csrfToken: string;
}

/** Pull one cookie's `name=value` pair out of a `set-cookie` header list. */
export function readCookie(
  setCookie: string | string[] | undefined,
  name: string,
): string | undefined {
  const all = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  for (const raw of all) {
    const [pair] = raw.split(';');
    const [key] = pair.split('=');
    if (key.trim() === name) return pair.trim();
  }
  return undefined;
}

/**
 * Sign in WITHOUT the CSRF round trip: the session cookie only. For specs about the sign-in itself, and
 * about what a request carrying only that cookie may do.
 */
export async function signInCookie(
  app: NestFastifyApplication,
  fixture: { email: string },
): Promise<{ userId: string; sessionCookie: string }> {
  await clearRateLimits(app);

  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/test-login',
    payload: { email: fixture.email },
  });
  const sessionCookie = readCookie(res.headers['set-cookie'], SESSION_COOKIE);

  if (res.statusCode !== 200 || !sessionCookie) {
    throw new Error(
      `test-login failed for ${fixture.email}: ${res.statusCode} ${res.body}. ` +
        'Is the database seeded (`pnpm db:seed`)? Is IDENTITY_TEST_LOGIN=enabled, and NODE_ENV test?',
    );
  }
  return { userId: res.json<{ user: { id: string } }>().user.id, sessionCookie };
}

/**
 * Authenticate as a seeded fixture and return everything needed to act as them.
 *
 * Throws on a failure instead of returning a half-session: a spec that silently continues
 * unauthenticated would then assert a 401/403 and pass for the wrong reason, which is the exact failure
 * mode an authorization suite must not have.
 */
export async function login(
  app: NestFastifyApplication,
  fixture: { email: string },
): Promise<Session> {
  const { userId, sessionCookie } = await signInCookie(app, fixture);

  const me = await app.inject({
    method: 'GET',
    url: '/v1/auth/me',
    headers: { cookie: sessionCookie },
  });
  const secret = readCookie(me.headers['set-cookie'], CSRF_SECRET_COOKIE);
  const { csrfToken } = me.json<{ csrfToken?: string }>();
  if (me.statusCode !== 200 || !secret || !csrfToken) {
    throw new Error(
      `GET /v1/auth/me gave no CSRF token for ${fixture.email}: ${me.statusCode} ${me.body}`,
    );
  }

  return { userId, sessionCookie, cookieHeader: `${sessionCookie}; ${secret}`, csrfToken };
}

/** The headers that authenticate a request as this session, CSRF included. */
export function authHeaders(session: Session): Record<string, string> {
  return { cookie: session.cookieHeader, 'x-csrf-token': session.csrfToken };
}

/** The HTTP verbs the suites use. Named so `apiRequest` cannot be handed a typo. */
export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface ApiResponse {
  status: number;
  body: unknown;
  /** Response headers, for the assertions that are about a header rather than a body. */
  headers?: Record<string, string | string[] | undefined>;
}

/**
 * One authenticated request against the in-process app.
 *
 * This, `unwrap` and `errorCode` were copy-pasted into eight spec files — twenty-four identical
 * definitions — before they moved here. That is the kind of duplication that looks harmless until one
 * copy diverges: a spec whose local `unwrap` does not understand the response envelope reads
 * `undefined` and asserts against it, which passes for the wrong reason.
 */
export async function apiRequest(
  app: NestFastifyApplication,
  session: Session,
  method: HttpMethod,
  url: string,
  payload?: Record<string, unknown>,
  /**
   * Extra request headers, merged over the session headers.
   *
   * For behaviour that lives in a HEADER rather than a body — `Idempotency-Key` is the first — so a
   * suite that needs one does not drop to a hand-rolled `app.inject` and lose the `/v1` prefix, the
   * auth, and the envelope parsing that everything else here shares.
   */
  headers?: Record<string, string>,
): Promise<ApiResponse> {
  const res = await app.inject({
    method,
    url: `/v1${url}`,
    headers: { ...authHeaders(session), ...headers },
    ...(payload === undefined ? {} : { payload }),
  });
  return {
    status: res.statusCode,
    body: (res.body ? JSON.parse(res.body) : {}) as unknown,
    headers: res.headers as Record<string, string | string[] | undefined>,
  };
}

/**
 * The payload out of the response envelope.
 *
 * Every successful response is `{ data, ... }` — paged ones add `pageInfo`. Falls back to the body
 * itself so an assertion against an error response still gets something readable rather than
 * `undefined`.
 */
export function unwrap<T>(body: unknown): T {
  const b = body as { data?: T };
  return (b.data ?? body) as T;
}

/** The `error.code` from a refusal, or undefined on success. */
export function errorCode(body: unknown): string | undefined {
  return (body as { error?: { code?: string } }).error?.code;
}
