import { z } from 'zod';
import { getProcessRole, type ProcessRole } from './process-role';
import { PRE_AUTH_IP_BUCKET } from '../rate-limit/rate-limit.constants';

const booleanish = (defaultValue: boolean) =>
  z
    .string()
    .default(String(defaultValue))
    .transform((v) => v === 'true');

/**
 * Treat an empty-string env var as "unset" so that `.optional()` fields disabled
 * via blank values (e.g. SSO left unconfigured) don't trip format validators.
 */
const emptyToUndefined = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (v === '' ? undefined : v), schema);

/**
 * Validated environment schema.
 * The process refuses to start if any required variable is missing or malformed.
 */
const baseShape = {
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /**
   * The DEFAULT rate-limit tier's ceiling, in requests per minute per user.
   *
   * Exists for ONE reason: the browser E2E suite drives fifty-odd specs through a handful of seeded
   * identities inside three minutes, and each page load costs about fifteen calls — so it crosses
   * 200/min and whichever request lands next comes back 429, failing a spec that was testing something
   * else. Spreading the specs over four seats helped locally and still lost in CI, which runs denser.
   *
   * IT CANNOT BE RAISED IN PRODUCTION. The refinement below refuses a value above the default when
   * `NODE_ENV=production`, so this is a test-environment accommodation and not a control with a dial on
   * it. Lowering it is always allowed.
   */
  /**
   * The pre-auth ceiling per client address (the first bucket every request passes through). The default is the
   * shipped `PRE_AUTH_IP_BUCKET` limit. CI's e2e suites drive every request from one loopback address, so they
   * raise it; `NODE_ENV=production` refuses a value above the default, so it is not a dial in a deployed environment.
   */
  RATE_LIMIT_IP_LIMIT: z.coerce.number().int().positive().default(PRE_AUTH_IP_BUCKET.limit),
  RATE_LIMIT_DEFAULT_LIMIT: z.coerce.number().int().positive().default(200),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  CORS_ORIGINS: z.string().default('http://localhost:5174'),

  // ── Database ───────────────────────────────────────────────────────────────
  // Supply EITHER a complete DATABASE_URL (local dev, CI) OR the discrete parts
  // (deployed). See db/database-url.ts for why the deployed path composes from
  // parts rather than storing a URL: the password belongs to the RDS-managed
  // secret that AWS rotates, and any copy of it goes stale silently.
  DATABASE_URL: z.string().url().optional(),
  DATABASE_HOST: z.string().optional(),
  DATABASE_PORT: z.coerce.number().int().positive().optional(),
  DATABASE_NAME: z.string().optional(),
  DATABASE_USER: z.string().optional(),
  DATABASE_PASSWORD: z.string().optional(),
  DATABASE_SSLMODE: z.string().default('require'),
  // Path to the CA bundle database certificates must chain to (RDS global bundle in the
  // image today, the CNPG ca.crt on-prem). REQUIRED in production: without it the
  // process refuses to connect (see db/pg-ssl.ts) instead of encrypting unverified.
  DATABASE_SSL_CA: emptyToUndefined(z.string().optional()),
  DATABASE_POOL_MIN: z.coerce.number().int().positive().default(2),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(20),

  // ── Auth (identity 8, Better Auth: the `staff` preset, Microsoft Entra) ──────
  // Sessions are database rows behind an HttpOnly cookie: there is no JWT, no refresh token and no key pair.
  // What only the API holds (BETTER_AUTH_SECRET, ENTRA_CLIENT_SECRET, IDENTITY_TEST_LOGIN) is declared on
  // ApiEnvSchema below, and the worker's schema refuses to start with it.

  // Entra ID tenant and sign-in app. The "OpsHub" app registration is DELEGATED-ONLY (openid, profile, email):
  // no application permission, and nothing in the sign-in path calls Graph. The tenant is shared with the Graph
  // worker app (a different registration in the same directory). The API requires both in production
  // (`refineApiAuth`); the worker only needs the tenant.
  ENTRA_TENANT_ID: emptyToUndefined(z.string().uuid().optional()),
  ENTRA_CLIENT_ID: emptyToUndefined(z.string().uuid().optional()),
  // Used to sign fastify-cookie (required for CSRF signed cookies).
  COOKIE_SECRET: z.string().min(32),
  /**
   * HMAC key binding a CSRF token to the session that requested it, so a token
   * lifted from one session cannot be replayed in another.
   *
   * Distinct from COOKIE_SECRET on purpose: that one signs every cookie, so rotating it invalidates all
   * of them. Sharing one value would make a cookie-hygiene rotation read as a CSRF change in the audit
   * trail, and vice versa.
   */
  CSRF_SECRET: z.string().min(32),

  // ── AWS (optional in dev) ──────────────────────────────────────────────────
  AWS_REGION: z.string().default('ap-southeast-1'),
  /** LocalStack/local-dev endpoint for the AWS SDK clients (SES, SQS). Unset in AWS. */
  AWS_ENDPOINT_URL: z.string().optional(),
  /** S3 bucket for all stored files — injected by infra as S3_FILES_BUCKET. Optional in dev (uploads stubbed when unset). */
  S3_FILES_BUCKET: z.string().optional(),
  /** CloudFront base URL for file downloads. When set, overrides presigned S3 GET URLs. */
  CDN_FILES_BASE_URL: z.string().optional(),

  // ── Object storage backend selector (AWS S3 by default; R2/MinIO when set) ──
  // Unset → AWS S3 via the task role (default). STORAGE_ENDPOINT set →
  // S3-compatible backend (Cloudflare R2, MinIO) with static credentials +
  // path-style addressing. R2 requires STORAGE_ENDPOINT + STORAGE_ACCESS_KEY_ID
  // + STORAGE_SECRET_ACCESS_KEY + STORAGE_FORCE_PATH_STYLE=true. The bucket name
  // still travels as S3_FILES_BUCKET.
  STORAGE_ENDPOINT: z.string().url().optional(),
  STORAGE_ACCESS_KEY_ID: z.string().optional(),
  STORAGE_SECRET_ACCESS_KEY: z.string().optional(),
  STORAGE_FORCE_PATH_STYLE: booleanish(false),

  // ── Observability ──────────────────────────────────────────────────────────
  SERVICE_VERSION: z.string().default('dev'),
  // The DEPLOYMENT environment (develop | production), distinct from NODE_ENV, which is production in every deployed environment on purpose.
  // Read by the shared observability package for the OTel resource and the log `env` field; the stack sets it (var.env).
  DEPLOYMENT_ENV: z.string().optional(),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  LOG_PRETTY: booleanish(false),
  LOG_SQL: booleanish(false),
  OTEL_ENABLED: booleanish(false),
  OTEL_SERVICE_NAME: z.string().default('opshub-api'),
  OTEL_WORKER_SERVICE_NAME: z.string().default('opshub-worker'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),

  // ── Cache (Valkey, Redis-compatible — optional in dev) ─────────────────────
  /** The cache's URL. THE name: infra, CI and `.env.example` all set it. The `redis://` scheme stays (the wire protocol). */
  VALKEY_URL: z.string().optional(),
  /**
   * DEPRECATED alias of VALKEY_URL, read for ONE more release. Every reader uses `get('VALKEY_URL')`; this survives only
   * so a developer's existing `.env` keeps booting, and setting it (without VALKEY_URL) logs a deprecation warning.
   * Delete it, and the `deriveEnv` line below, in the release after.
   */
  REDIS_URL: z.string().optional(),
  REDIS_KEY_PREFIX: z.string().default('opshub:'),

  // ── Background jobs ────────────────────────────────────────────────────────
  /** Audit log retention in days (SOC 2 baseline: 730 = 2 years). */
  AUDIT_RETENTION_DAYS: z.coerce.number().int().positive().default(730),

  // ── Door attendance terminal ───────────────────────────────────────────────
  /**
   * Attendance event retention in days (ADR ATTENDANCE-DEVICE §2.7: personal data kept no longer
   * than needed). 24 months by default. Unknown-card events purge at a fixed 30 days (not
   * configurable: visitors' bank cards are not records we keep).
   */
  DOOR_EVENT_RETENTION_DAYS: z.coerce
    .number()
    .int()
    .min(30) // never shorter than the unknown-card window's own clock (480 nit)
    .default(730),
  /**
   * Healthchecks.io ping URL for the door-terminal check. Optional, DEFAULT OFF: unset, the
   * monitoring job is a no-op. Set it and the worker pings only while EVERY active terminal was
   * seen within the last 10 minutes — Healthchecks alerts on the ping that never arrives.
   */
  DOOR_TERMINAL_HEALTHCHECK_URL: z.string().url().optional(),

  // ── AI assistant (optional) ────────────────────────────────────────────────
  // When ANTHROPIC_API_KEY is unset the AI module reports itself disabled
  // (AiService.isEnabled()) and the /ai endpoints return 503.
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default('claude-opus-4-8'),

  // ── Webhooks ───────────────────────────────────────────────────────────────
  /**
   * How long a webhook delivery may wait, `pending`, before the relay stops trying to send it: past this age it is
   * marked `failed` ("expired: pending longer than N h") and never sent. A delivery's body carries the time of SENDING,
   * so a receiver cannot tell a stale event from a fresh one, and a relay that was down for a day would otherwise
   * replay that day to every subscriber the moment it came back. The row is kept (no delete). Whole hours.
   */
  WEBHOOK_DELIVERY_MAX_AGE_HOURS: z.coerce.number().int().positive().default(24),

  // ── Email ──────────────────────────────────────────────────────────────────
  /**
   * Which transport actually sends.
   *
   * `graph` sends through Microsoft 365 (Graph `sendMail`) from the product's shared mailbox
   * (HYBRID-INFRA-PLAN §7.4): see `docs/runbooks/mail-graph.md`. SES and Resend were removed
   * (opshub#410): graph is the only sending transport.
   * `dev` logs to the console and sends nothing, which is the default so that a fresh checkout needs no
   * mail setup at all.
   */
  EMAIL_PROVIDER: z.enum(['dev', 'graph', 'smtp']).default('dev'),
  /** SMTP relay host for EMAIL_PROVIDER=smtp: Mailpit (`localhost` on the host, `mailpit` in a container). Development only. */
  MAIL_SMTP_HOST: emptyToUndefined(z.string().min(1).optional()),
  /** SMTP relay port for EMAIL_PROVIDER=smtp: Mailpit's SMTP port (1025 in the container). */
  MAIL_SMTP_PORT: emptyToUndefined(z.coerce.number().int().min(1).max(65535).optional()),
  /**
   * The shared mailbox mail goes out as (`noreply-opshub@qnsc.vn`). Required for `graph`. Not a secret.
   * Graph sends as this mailbox and no other; the display name is the mailbox's own, so `MAIL_FROM_NAME`
   * does not apply to it.
   */
  MAIL_GRAPH_SENDER: emptyToUndefined(z.string().email().optional()),
  /**
   * NO DEFAULT, deliberately — see the refusal in the `superRefine` below.
   *
   * This defaulted to `no-reply@opshub.app`, a domain a given deployment may not own. So a
   * production configured with `EMAIL_PROVIDER=resend` and no sender did not fail: it sent from an
   * address that fails SPF and DKIM at the receiving end, which is silent non-delivery or delivery
   * to spam, and nothing in our logs explains either. The sibling repo added the same refusal after
   * finding both of its deployed environments running exactly that way.
   */
  // emptyToUndefined, not bare .optional(): Terraform injects both of these as a literal
  // empty string when unset (`value = var.mail_from_email`, unconditionally, no ternary),
  // and Zod's .optional() accepts `undefined` but still runs .email() against an explicit
  // "" — which fails, and does so for BOTH fields at once, so this crashed every task in
  // every environment that leaves mail unconfigured. Confirmed live: opshub-develop's api
  // task crash-looped on exactly "MAIL_FROM_EMAIL: Invalid email address" /
  // "MAIL_REPLY_TO: Invalid email address" before this fix, same class of bug the
  // ENTRA_* fields above already guard against.
  MAIL_FROM_EMAIL: emptyToUndefined(z.string().email().optional()),
  MAIL_REPLY_TO: emptyToUndefined(z.string().email().optional()),
  // ── Frontend ───────────────────────────────────────────────────────────────
  /** Public base URL used to build links inside notification emails. */
  APP_URL: z.string().url().default('http://localhost:5174'),
};

/** What every role's schema shares. */
type Common = z.infer<z.ZodObject<typeof baseShape>>;

/**
 * Cross-field rules, shared by every role's schema. Written against the common variables so they apply
 * unchanged to each role's concrete schema ({@link ApiEnvSchema}, {@link WorkerEnvSchema}).
 */
const refineEnv = (env: Common, ctx: z.RefinementCtx): void => {
  {
    // A RATE LIMIT TESTS CAN RAISE IS NOT A CONTROL. The knob exists for CI; production keeps the
    // shipped ceiling, and this refusal is what makes that a rule rather than a comment. Deliberately
    // placed above the early return below, for the reason that comment gives.
    if (env.NODE_ENV === 'production' && env.RATE_LIMIT_IP_LIMIT > PRE_AUTH_IP_BUCKET.limit) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['RATE_LIMIT_IP_LIMIT'],
        message:
          'RATE_LIMIT_IP_LIMIT cannot exceed ' +
          PRE_AUTH_IP_BUCKET.limit +
          ' when NODE_ENV=production: the per-address bucket is a protective ' +
          'control, and an environment that raises it stops describing production. Lowering it is allowed.',
      });
    }
    if (env.NODE_ENV === 'production' && env.RATE_LIMIT_DEFAULT_LIMIT > 200) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['RATE_LIMIT_DEFAULT_LIMIT'],
        message:
          'RATE_LIMIT_DEFAULT_LIMIT cannot exceed 200 when NODE_ENV=production: the default tier is a ' +
          'protective control, and an environment that raises it stops describing production. Lowering ' +
          'it is allowed.',
      });
    }

    /*
     * A NON-DEV EMAIL PROVIDER MUST HAVE A SENDER. Placed above the early return below for the same
     * reason the rate-limit check is: everything after that line is dead in the configuration
     * developers and CI actually run, and a check that cannot fire is not a check.
     *
     * `dev` is exempt because `DevEmailProvider` logs instead of sending, so it has nothing to be
     * from. Anything else reaches a real mail service, and reaching one without a verified sender is
     * the failure this refuses to boot into.
     */
    if (env.EMAIL_PROVIDER === 'graph' && !env.MAIL_GRAPH_SENDER) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['MAIL_GRAPH_SENDER'],
        message:
          'MAIL_GRAPH_SENDER is required when EMAIL_PROVIDER is "graph": it is the shared mailbox Graph sends as ' +
          '(noreply-opshub@qnsc.vn), and the Exchange role assignment names exactly that mailbox.',
      });
    }
    if (env.EMAIL_PROVIDER === 'smtp' && env.NODE_ENV === 'production') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['EMAIL_PROVIDER'],
        message:
          'EMAIL_PROVIDER=smtp is for development only (Mailpit): an unauthenticated relay must never send in production. Use graph.',
      });
    }
    if (env.EMAIL_PROVIDER === 'smtp' && (!env.MAIL_SMTP_HOST || !env.MAIL_SMTP_PORT)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['MAIL_SMTP_HOST'],
        message:
          'MAIL_SMTP_HOST and MAIL_SMTP_PORT are required when EMAIL_PROVIDER is "smtp" (Mailpit: localhost and 1110 on the host, mailpit and 1025 in a container).',
      });
    }
    if (env.EMAIL_PROVIDER !== 'dev' && env.EMAIL_PROVIDER !== 'graph' && !env.MAIL_FROM_EMAIL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['MAIL_FROM_EMAIL'],
        message:
          `MAIL_FROM_EMAIL is required when EMAIL_PROVIDER is "${env.EMAIL_PROVIDER}": mail sent from ` +
          'an unverified address fails SPF and DKIM at the recipient, which looks like silent ' +
          'non-delivery rather than a misconfiguration. Set a sender on a domain this deployment owns.',
      });
    }

    // BEFORE the database early-return below, and that placement is the point. This
    // superRefine returns as soon as a complete DATABASE_URL is present, so anything
    // written after that line is dead in exactly the configuration developers and CI run.
    // (rova's equivalent storage-pair check sits after its return and is inert there.)
    //
    // Half a credential pair is a misconfiguration, not a partial feature. With only one
    // half set, the S3Client silently omits `credentials` and falls back to the task
    // role — which for AWS S3 quietly works and for R2 fails at the first request with a
    // signature error naming nothing useful.
    const keyId = Boolean(env.STORAGE_ACCESS_KEY_ID);
    const keySecret = Boolean(env.STORAGE_SECRET_ACCESS_KEY);
    if (keyId !== keySecret) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [keyId ? 'STORAGE_SECRET_ACCESS_KEY' : 'STORAGE_ACCESS_KEY_ID'],
        message:
          'STORAGE_ACCESS_KEY_ID and STORAGE_SECRET_ACCESS_KEY must be set together, or ' +
          'both left unset to use the task role against AWS S3.',
      });
    }

    // A non-AWS endpoint has no instance role to fall back on, so credentials are not
    // optional there — omitting them produces a client that signs with nothing and fails
    // on the first upload rather than at boot.
    if (env.STORAGE_ENDPOINT && !(keyId && keySecret)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['STORAGE_ACCESS_KEY_ID'],
        message:
          'STORAGE_ENDPOINT requires STORAGE_ACCESS_KEY_ID and STORAGE_SECRET_ACCESS_KEY: ' +
          'an S3-compatible backend has no task role to fall back to.',
      });
    }

    // Database credentials must arrive by exactly one of the two routes. Checked here
    // so a misconfigured task dies at boot with a precise message, rather than
    // surviving startup and failing on the first query — which is how a stale db-url
    // secret presents: a healthy-looking deploy, then 28P01.
    if (env.DATABASE_URL) return;

    const missing = (
      [
        'DATABASE_HOST',
        'DATABASE_PORT',
        'DATABASE_NAME',
        'DATABASE_USER',
        'DATABASE_PASSWORD',
      ] as const
    ).filter((k) => !env[k]);

    if (missing.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['DATABASE_URL'],
        message:
          `Database not configured. Set DATABASE_URL, or all of DATABASE_HOST, DATABASE_PORT, ` +
          `DATABASE_NAME, DATABASE_USER, DATABASE_PASSWORD. Missing: ${missing.join(', ')}.`,
      });
    }
  }
};

let warnedRedisUrl = false;

/** Derivations, shared by every role: the deprecated cache alias folds into VALKEY_URL. */
const deriveEnv = <E extends Common>(env: E): E & { VALKEY_URL: string | undefined } => {
  if (env.REDIS_URL && !env.VALKEY_URL && !warnedRedisUrl) {
    warnedRedisUrl = true;
    process.emitWarning(
      'REDIS_URL is deprecated: set VALKEY_URL to the same value. REDIS_URL is still read for one more release.',
      { type: 'DeprecationWarning', code: 'OPSHUB_REDIS_URL' },
    );
  }
  return {
    ...env,
    // Normalise at parse time so every reader uses get('VALKEY_URL'). VALKEY_URL wins when both are set (infra sets it).
    VALKEY_URL: env.VALKEY_URL ?? env.REDIS_URL,
  };
};

/**
 * A variable the process must NOT have. Present (non-empty) => the process refuses to start, naming it.
 * The value is never echoed.
 */
const forbidden = (name: string, role: 'API' | 'worker', why: string) =>
  z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.undefined({ error: `${name} must not be set on the ${role}: ${why}` }),
  );

const GRAPH_WHY =
  'Microsoft Graph is worker-only; the API asks for Graph work through graph_task_outbox';

/** A signing key: at least 32 characters once trimmed (the length `platform-http` itself enforces). */
const edgeSecret = z
  .string()
  .refine((v) => v.trim().length >= 32, 'must be at least 32 characters: it is a signing key');

/**
 * What only the API's sign-in needs, checked where sign-in is real. Placed in its own refinement, not in
 * {@link refineEnv}, because the worker has none of these variables and must not be asked for them.
 */
const refineApiAuth = (
  env: Common & {
    ENTRA_CLIENT_SECRET?: string;
    IDENTITY_TEST_LOGIN?: 'enabled';
    EDGE_CLIENT_IP_SECRET?: string;
    EDGE_CLIENT_IP_SECRET_PREVIOUS?: string;
  },
  ctx: z.RefinementCtx,
): void => {
  // A previous key with no current one is a rotation half done: `clientIp()` refuses to start on it, so say so here.
  if (env.EDGE_CLIENT_IP_SECRET_PREVIOUS && !env.EDGE_CLIENT_IP_SECRET) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['EDGE_CLIENT_IP_SECRET_PREVIOUS'],
      message: 'EDGE_CLIENT_IP_SECRET_PREVIOUS is set but EDGE_CLIENT_IP_SECRET is not.',
    });
  }

  // SIGN-IN MUST BE CONFIGURED WHERE IT IS REAL. In production a missing Entra setting is a refused boot, not a
  // login page that sends everyone to an error; in development and CI the Entra fields may stay unset
  // (test-login signs in).
  if (env.NODE_ENV !== 'production') return;
  for (const key of [
    'ENTRA_TENANT_ID',
    'ENTRA_CLIENT_ID',
    'ENTRA_CLIENT_SECRET',
    'EDGE_CLIENT_IP_SECRET',
  ] as const) {
    if (!env[key]) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message:
          key === 'EDGE_CLIENT_IP_SECRET'
            ? "EDGE_CLIENT_IP_SECRET is required when NODE_ENV=production: every browser request reaches the API through the Pages Function, which signs the visitor address with it. Without it the API sees one shared Cloudflare address and the per-address rate-limit bucket is the whole company's."
            : `${key} is required when NODE_ENV=production: staff sign in with Microsoft Entra.`,
      });
    }
  }
  if (env.IDENTITY_TEST_LOGIN) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['IDENTITY_TEST_LOGIN'],
      message:
        'IDENTITY_TEST_LOGIN cannot be set when NODE_ENV=production: it is a passwordless sign-in for ' +
        'end-to-end suites only.',
    });
  }
  if (!env.APP_URL.startsWith('https://')) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['APP_URL'],
      message:
        'APP_URL must be https when NODE_ENV=production: it is the origin Entra redirects the browser to ' +
        '(/api/auth/callback/microsoft) and the origin of the session cookie.',
    });
  }
};

/**
 * The API process. Holds everything sign-in needs and NO Graph variable: a request that needs Graph writes a
 * task row and the worker performs it, so there is no Graph credential here to steal.
 */
export const ApiEnvSchema = z
  .object({
    ...baseShape,

    /**
     * Signs identity's cookies and encrypts what it stores (identity README, "Environment"). 32+ characters,
     * its own secret: not COOKIE_SECRET (opshub's cookies) and not CSRF_SECRET. Rotating it signs everyone out.
     * API ONLY: the worker never signs anyone in, and its schema refuses to start with this set.
     */
    BETTER_AUTH_SECRET: z.string().min(32),
    /**
     * `IDENTITY_TEST_LOGIN=enabled` loads identity's passwordless `/api/auth/test-login` for the end-to-end
     * suites. Identity itself refuses it unless NODE_ENV is `test` or `development`; this schema ALSO refuses it in
     * production (`refineApiAuth`), so a misconfigured pod does not even reach that check.
     */
    IDENTITY_TEST_LOGIN: emptyToUndefined(z.enum(['enabled']).optional()),
    /**
     * The Entra confidential-client secret of the sign-in app, used only in the server-side code exchange. NOT a
     * Graph credential: the Graph worker app has no client secret at all. Optional here so development and CI
     * boot without one; required in production by `refineApiAuth`.
     */
    ENTRA_CLIENT_SECRET: emptyToUndefined(z.string().min(1).optional()),
    /**
     * The key the Cloudflare Pages Function signs the visitor's address with (`@quynhonsemiconductor/platform-http/edge`),
     * and `clientIp()` verifies. Behind a Pages Function the API's `cf-connecting-ip` is a Cloudflare address shared
     * by every visitor, so without a verifiable address one per-address rate-limit bucket (`PRE_AUTH_IP_BUCKET`) would be
     * the whole company's. The SAME value as the Pages project's secret of that name; at least 32 characters.
     * Optional so development and CI (no Pages Function in front) boot, where `clientIp()` treats an absent secret as
     * "no signed address, use cf-connecting-ip"; REQUIRED in production (`refineApiAuth`), where an empty value stops
     * the boot: the only way a browser reaches the API is through the Function, and that means a shared address.
     */
    EDGE_CLIENT_IP_SECRET: emptyToUndefined(edgeSecret.optional()),
    /** The previous key, accepted for verification only while the Pages secret is being rotated. */
    EDGE_CLIENT_IP_SECRET_PREVIOUS: emptyToUndefined(edgeSecret.optional()),
    GRAPH_CLIENT_ID: forbidden('GRAPH_CLIENT_ID', 'API', GRAPH_WHY),
    GRAPH_CLIENT_CERTIFICATE: forbidden('GRAPH_CLIENT_CERTIFICATE', 'API', GRAPH_WHY),
    GRAPH_FEDERATED_TOKEN_FILE: forbidden('GRAPH_FEDERATED_TOKEN_FILE', 'API', GRAPH_WHY),
  })
  .superRefine(refineEnv)
  .superRefine(refineApiAuth)
  .transform(deriveEnv);

/**
 * The worker is the only process that SENDS mail (the API writes outbox rows), so it is the only one asked for the Graph credential.
 * With `EMAIL_PROVIDER=graph` it must have the Graph worker app and a credential for it; otherwise the first invitation would dead-letter on
 * `config` instead of the deploy failing. The API is not asked: it is forbidden to hold any of these.
 */
const refineWorkerMail = (
  env: Common & {
    GRAPH_CLIENT_ID?: string;
    GRAPH_CLIENT_CERTIFICATE?: string;
    GRAPH_FEDERATED_TOKEN_FILE?: string;
  },
  ctx: z.RefinementCtx,
): void => {
  if (env.EMAIL_PROVIDER !== 'graph') return;
  const need = (name: string, why: string): void =>
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [name],
      message: `${name} is required: ${why}`,
    });
  if (!env.ENTRA_TENANT_ID) {
    need('ENTRA_TENANT_ID', 'EMAIL_PROVIDER=graph signs in to this directory.');
  }
  if (!env.GRAPH_CLIENT_ID) {
    need(
      'GRAPH_CLIENT_ID',
      'EMAIL_PROVIDER=graph sends as the Graph worker app, which holds the Exchange "Application Mail.Send" role for the mailbox.',
    );
  }
  if (!env.GRAPH_CLIENT_CERTIFICATE && !env.GRAPH_FEDERATED_TOKEN_FILE) {
    need(
      'GRAPH_CLIENT_CERTIFICATE',
      'EMAIL_PROVIDER=graph has no credential (set it on ECS, or GRAPH_FEDERATED_TOKEN_FILE on k3s).',
    );
  }
};

/**
 * The worker process. Holds the Graph variables and NO sign-in secret: the worker never runs a login
 * callback.
 */
export const WorkerEnvSchema = z
  .object({
    ...baseShape,

    /**
     * Client id of the Graph WORKER app — a different app registration from ENTRA_CLIENT_ID, which is
     * the sign-in app and holds no application permissions. READ ONLY BY THE WORKER
     * (`libs/modules/graph`); the API task is not given any GRAPH_* variable, so a compromised API
     * process has no Graph credential to steal.
     *
     * UNSET MEANS OFF. Every Graph feature (Intune device sync, shadow-IT scan, Secure Score, Entra
     * account disable/enable and session revoke) skips with one info log instead of failing against a
     * tenant that never consented. The tenant is ENTRA_TENANT_ID: one directory, two apps.
     */
    GRAPH_CLIENT_ID: emptyToUndefined(z.string().uuid().optional()),
    /**
     * Credential, option 1 (ECS, now): PEM holding the app's private key AND its certificate, raw or
     * base64. The public half is uploaded to the Graph worker app registration. No client secret exists
     * for that app.
     */
    GRAPH_CLIENT_CERTIFICATE: emptyToUndefined(
      z
        .string()
        .min(1)
        .transform((v) =>
          v.includes('-----BEGIN') ? v : Buffer.from(v, 'base64').toString('utf8'),
        )
        .refine((v) => v.includes('-----BEGIN'), 'GRAPH_CLIENT_CERTIFICATE must be a PEM')
        .optional(),
    ),
    /**
     * Credential, option 2 (k3s, later): path of the projected ServiceAccount token that Entra
     * exchanges through a federated identity credential on the Graph worker app. No secret and no
     * certificate. Wins over GRAPH_CLIENT_CERTIFICATE when both are set, so the cut-over is adding
     * this variable.
     */
    GRAPH_FEDERATED_TOKEN_FILE: emptyToUndefined(z.string().min(1).optional()),
    ENTRA_CLIENT_SECRET: forbidden(
      'ENTRA_CLIENT_SECRET',
      'worker',
      'only the API completes a sign-in; the worker has no use for it',
    ),
    BETTER_AUTH_SECRET: forbidden(
      'BETTER_AUTH_SECRET',
      'worker',
      'only the API runs identity; a worker holding it could forge a session cookie',
    ),
    IDENTITY_TEST_LOGIN: forbidden(
      'IDENTITY_TEST_LOGIN',
      'worker',
      'the passwordless test sign-in exists on the API only',
    ),
    EDGE_CLIENT_IP_SECRET: forbidden(
      'EDGE_CLIENT_IP_SECRET',
      'worker',
      'only the API verifies the signed client address; the worker serves no visitor',
    ),
    EDGE_CLIENT_IP_SECRET_PREVIOUS: forbidden(
      'EDGE_CLIENT_IP_SECRET_PREVIOUS',
      'worker',
      'only the API verifies the signed client address; the worker serves no visitor',
    ),
  })
  .superRefine(refineEnv)
  .superRefine(refineWorkerMail)
  .transform(deriveEnv);

/** Role-specific variables are typed on {@link ApiEnv} / {@link WorkerEnv}. */
type GraphKey = 'GRAPH_CLIENT_ID' | 'GRAPH_CLIENT_CERTIFICATE' | 'GRAPH_FEDERATED_TOKEN_FILE';
/** The variables only the API has (sign-in). The worker's schema refuses to start with any of them set. */
type ApiOnlyKey =
  | 'ENTRA_CLIENT_SECRET'
  | 'BETTER_AUTH_SECRET'
  | 'IDENTITY_TEST_LOGIN'
  | 'EDGE_CLIENT_IP_SECRET'
  | 'EDGE_CLIENT_IP_SECRET_PREVIOUS';

/**
 * What each role's config service can READ. The forbidden variables are in the schemas (so a set one
 * refuses to start) but not in these types, so `get('GRAPH_CLIENT_ID')` does not compile on the API.
 */
export type ApiEnv = Omit<z.infer<typeof ApiEnvSchema>, GraphKey>;
export type WorkerEnv = Omit<z.infer<typeof WorkerEnvSchema>, ApiOnlyKey>;

/** What every process has in common. */
export type Env = Omit<ApiEnv, ApiOnlyKey>;

export function schemaForRole(role: ProcessRole) {
  return role === 'api' ? ApiEnvSchema : WorkerEnvSchema;
}

/**
 * The schema the config module validates with: resolved when validation RUNS, not when this module is
 * imported, so the entry point's `setProcessRole` has taken effect. An unset role is an error, not a
 * default — a process that does not know what it is must not guess which credentials it may hold.
 */
export const EnvSchema = {
  safeParse(data: unknown): ReturnType<typeof ApiEnvSchema.safeParse> {
    const role = getProcessRole();
    if (!role) {
      throw new Error(
        'The process role is not set. The entry point must import its role module (apps/<app>/src/role.ts) ' +
          'before anything that loads @platform.',
      );
    }
    // The two roles' outputs differ only in the variables each owns; consumers read the common `Env`.
    return schemaForRole(role).safeParse(data) as unknown as ReturnType<
      typeof ApiEnvSchema.safeParse
    >;
  },
};
