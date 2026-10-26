import fastifyCompress from '@fastify/compress';
import fastifyCookie from '@fastify/cookie';
import fastifyCsrf from '@fastify/csrf-protection';
import fastifyHelmet from '@fastify/helmet';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { assertEdgeClientIpEnv } from '@quynhonsemiconductor/platform-http';
import { enableHealth } from '@quynhonsemiconductor/platform-runtime';
import { DOOR_TERMINAL_BODY_LIMIT, isDoorTerminalRoute } from './door-body-limit';
import {
  AppConfigService,
  SESSION_COOKIE,
  CSRF_HEADER,
  CSRF_SECRET_COOKIE,
  registerRequestTiming,
  requiresCsrfProtection,
} from '@platform';

/**
 * Applies cross-cutting HTTP concerns to the Fastify app: security headers,
 * compression, cookies, CSRF (double-submit cookie), CORS, the global `/v1`
 * prefix and the OpenAPI document served at `/api/docs`.
 */
export async function bootstrapApp(app: NestFastifyApplication): Promise<void> {
  const config = app.get(AppConfigService);

  // `clientIp()` (the rate limiter, the access log, idempotency and identity's mount all call it) reads
  // EDGE_CLIENT_IP_SECRET lazily, on the first request. A bad key is refused HERE, at boot, naming the variable,
  // instead of surfacing as a 500 on whichever request arrives first. (platform-http's own guard does the same
  // in its bootstrap hook; opshub's guards are local, so the check is made explicitly.)
  assertEdgeClientIpEnv();

  await app.register(fastifyHelmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
      },
    },
  });
  await app.register(fastifyCompress);
  const cookieSecret = config.get('COOKIE_SECRET');
  await app.register(fastifyCookie, { secret: cookieSecret });

  // ── CSRF (double-submit, session-bound) ─────────────────────────────────────
  // The secret lives in a signed `__Host-` cookie; the token is handed to the SPA by
  // GET /v1/auth/me and echoed back in the X-CSRF-Token header. `userInfo` binds each
  // token to the session id that requested it (HMAC'd with CSRF_SECRET), so a token
  // lifted from one session cannot be replayed in another.
  //
  // Registering the plugin only decorates `reply.generateCsrf()` and
  // `app.csrfProtection` — it enforces NOTHING until the hook below attaches it.
  await app.register(fastifyCsrf, {
    sessionPlugin: '@fastify/cookie',
    cookieKey: CSRF_SECRET_COOKIE,
    cookieOpts: { signed: true, httpOnly: true, secure: true, sameSite: 'strict', path: '/' },
    // Header only. The default also reads `body._csrf`, which is never populated here and
    // would accept a token an attacker can plant in a form post.
    getToken: (req) => {
      const header = req.headers[CSRF_HEADER];
      return Array.isArray(header) ? header[0] : header;
    },
    getUserInfo: (req) => req.cookies?.[SESSION_COOKIE] ?? '',
    csrfOpts: { hmacKey: config.get('CSRF_SECRET'), userInfo: true },
  });

  // Enforce on every cookie-authenticated state-changing request. Attaching the check
  // in ONE hook rather than per route is deliberate: with decorators, a new controller
  // is unprotected until someone remembers, and the omission is invisible in review.
  // Here the default is protected and `requiresCsrfProtection` is the single place the
  // policy lives — see libs/platform/src/http/csrf.ts for which requests it selects and
  // why each exemption exists.
  const fastify = app.getHttpAdapter().getInstance();

  // Registered BEFORE the CSRF gate, and before any hook that can reject: this only
  // stamps an arrival timestamp, and it has to run on every request that reaches the
  // process — including ones something later refuses — or the access log loses the
  // arrival time for exactly the requests worth investigating.
  registerRequestTiming(fastify);

  // Route-level body cap for the door-terminal listener (SA review #493 item 6): Fastify
  // enforces bodyLimit on the STREAM of received bytes, so chunked or missing Content-Length
  // cannot slip past the way a header pre-check let them. A batch is ≤ 100 events × ~200 bytes;
  // 64 KB is an order of magnitude above honest traffic and far below anything worth parsing.
  fastify.addHook('onRoute', (route) => {
    if (isDoorTerminalRoute(route.url)) {
      route.bodyLimit = DOOR_TERMINAL_BODY_LIMIT;
    }
  });

  fastify.addHook('onRequest', function csrfGate(req, reply, done) {
    if (!requiresCsrfProtection(req)) return done();
    fastify.csrfProtection(req, reply, done);
  });

  app.enableCors({
    origin: config
      .get('CORS_ORIGINS')
      .split(',')
      .map((o) => o.trim()),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Correlation-Id',
      'X-CSRF-Token',
      // Without this the browser's preflight refuses the request before it is sent, so the global
      // IdempotencyInterceptor could never see a key — the feature existed and was unreachable.
      'Idempotency-Key',
      'traceparent',
      'tracestate',
      'baggage',
    ],
    exposedHeaders: [
      'X-Correlation-Id',
      'RateLimit-Limit',
      'RateLimit-Remaining',
      'Retry-After',
      // The other half: a browser cannot read a response header that is not exposed, so a client had
      // no way to tell a replay from a fresh execution even if the request had got through.
      'X-Idempotent-Replayed',
    ],
  });

  app.setGlobalPrefix('v1');

  // /livez, /readyz and the legacy /v1/healthz, /v1/readyz (the ALB target group, the Dockerfile HEALTHCHECK, the
  // deploy smoke test and the chart's readiness path), from `@quynhonsemiconductor/platform-runtime`. Raw Fastify
  // routes on purpose: a controller would inherit the `v1` prefix (`/v1/livez` is a rejected manifest, because
  // gitops/platform/policy/admission.yaml denies any liveness path but `/livez`), the global session guard, the rate
  // limiter and the OpenAPI document. `/readyz` answers 503 once shutdown has begun. Its `database` and `cache`
  // checks are built in: the pool is found under platform-db's token (`DatabaseModule` provides it) and the cache by
  // `CacheService`. The cause of a failed check is logged, never returned: the endpoint is unauthenticated.
  enableHealth(app);

  // Expose OpenAPI only outside production — avoids leaking endpoint inventory
  if (!config.get('NODE_ENV').startsWith('prod')) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('OpsHub API')
      .setDescription(
        /*
         * IDEMPOTENCY IS DOCUMENTED HERE, not as a header parameter on every route.
         *
         * The interceptor is global, so expressing it in the schema would mean adding the same optional
         * header to roughly two hundred mutating operations — bloating the spec and the generated
         * client for a cross-cutting concern that is identical everywhere. The description is where a
         * consumer reads about behaviour that is not per-route, and the two error codes ARE in the
         * catalogue, so a client can branch on them.
         */
        'Internal operations platform — assets, access, compliance, workforce.\n\n' +
          '**Idempotent retries.** Send `Idempotency-Key: <uuid>` on any POST, PUT or PATCH and the ' +
          'response is replayed for 24 hours instead of the request being performed twice. A replay ' +
          'carries `X-Idempotent-Replayed: true`. The key is scoped to the calling identity.\n\n' +
          'Only successful responses are stored, so a failed request stays retryable. Reusing a key ' +
          'with a different body is refused with `IDEMPOTENCY_KEY_REUSED` (422) rather than answered ' +
          'with the first request\u2019s response. A retry that arrives while the first copy is still ' +
          'running gets `IDEMPOTENCY_IN_FLIGHT` (409) — retry shortly.',
      )
      .setVersion(config.get('SERVICE_VERSION'))
      .addCookieAuth(
        SESSION_COOKIE,
        { type: 'apiKey', in: 'cookie', name: SESSION_COOKIE },
        'session',
      )
      .build();
    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('api/docs', app, document, {
      jsonDocumentUrl: 'api/docs-json',
    });
  }
}
