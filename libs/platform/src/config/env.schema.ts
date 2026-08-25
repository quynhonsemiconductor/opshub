import { createPrivateKey, createPublicKey } from 'node:crypto';
import { z } from 'zod';
import { SEC_PER_DAY } from '@shared-kernel';

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
export const EnvSchema = z
  .object({
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
    RATE_LIMIT_DEFAULT_LIMIT: z.coerce.number().int().positive().default(200),
    PORT: z.coerce.number().int().positive().default(3000),
    HOST: z.string().default('0.0.0.0'),
    CORS_ORIGINS: z.string().default('http://localhost:5173'),

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
    DATABASE_POOL_MIN: z.coerce.number().int().positive().default(2),
    DATABASE_POOL_MAX: z.coerce.number().int().positive().default(20),

    // ── Auth ───────────────────────────────────────────────────────────────────
    // JWT — ES256 asymmetric signing (ECDSA over NIST P-256 / prime256v1).
    // Keys must be PEM-encoded EC P-256 keypair. Accepted as raw PEM or base64-encoded PEM.
    // Generate: openssl ecparam -name prime256v1 -genkey -noout | openssl pkcs8 -topk8 -nocrypt
    JWT_PRIVATE_KEY: z
      .string()
      .min(1)
      .transform((v) => (v.includes('-----BEGIN') ? v : Buffer.from(v, 'base64').toString('utf8')))
      .refine((v) => v.includes('-----BEGIN'), 'JWT_PRIVATE_KEY must be a PEM-encoded private key'),
    /**
     * OPTIONAL — derived from JWT_PRIVATE_KEY when absent (see the transform at the
     * bottom of this file). Supply it only to override, e.g. a local .env that already
     * has a pair. Nothing needs it configured: an ES256 public key is a pure function
     * of its private key, and opshub publishes no JWKS, so no verifier exists that
     * lacks the private key.
     */
    JWT_PUBLIC_KEY: z
      .string()
      .min(1)
      .transform((v) => (v.includes('-----BEGIN') ? v : Buffer.from(v, 'base64').toString('utf8')))
      .refine((v) => v.includes('-----BEGIN'), 'JWT_PUBLIC_KEY must be a PEM-encoded public key')
      .optional(),

    // Entra ID SSO — required in production, optional in dev (enables entra-login endpoint).
    ENTRA_TENANT_ID: emptyToUndefined(z.string().uuid().optional()),
    ENTRA_CLIENT_ID: emptyToUndefined(z.string().uuid().optional()),
    /** Microsoft Graph app client secret — client-credentials flow for Graph sync jobs (compliance, security-posture, workforce). Optional; features self-disable when unset. */
    GRAPH_CLIENT_SECRET: z.string().min(1).optional(),
    // Used to sign fastify-cookie (required for CSRF signed cookies).
    COOKIE_SECRET: z.string().min(32),
    /** Short-lived access token — 15 min is enterprise standard (token theft window). */
    JWT_ACCESS_EXPIRY: z.string().default('15m'),
    /** Refresh token TTL in days — stored as HttpOnly cookie, hashed in DB, revocable. */
    JWT_REFRESH_EXPIRY_DAYS: z.coerce.number().int().positive().default(7),
    JWT_ISSUER: z.string().default('opshub-api'),
    JWT_AUDIENCE: z.string().default('opshub-web'),

    // ── BFF (Backend-for-Frontend) — server-side OIDC session ──────────────────
    // The API is a *confidential* OIDC client: it runs the Entra Authorization-Code
    // + PKCE flow server-side and issues an opaque, httpOnly `__Host-` session
    // cookie, so no Entra or JWT token ever reaches the browser. The SPA reaches
    // these routes same-origin through the Cloudflare Pages Function proxy.
    /**
     * Entra confidential-client secret, used only in the server-side code exchange.
     *
     * OPTIONAL, unlike rally's, and deliberately so: opshub's Entra app registration
     * has no client secret minted yet. An empty secret leaves the login path
     * unusable — `/v1/bff/login` still returns an authorize URL, and the callback's
     * token exchange is what fails — while the app boots and both the Bearer path and
     * dev-login keep working. Making it required instead would turn a missing secret
     * into a crash-looping service.
     */
    ENTRA_CLIENT_SECRET: z.string().min(1).optional(),
    /**
     * Absolute URL of the BFF OIDC callback, which must also be registered as a
     * redirect URI on the Entra app registration — e.g.
     * https://opshub-dev.qnsc.vn/v1/bff/callback. Note the SPA origin, not the API
     * origin: the browser is redirected here, and it must land same-origin so the
     * session cookie set on the response is accepted.
     */
    ENTRA_REDIRECT_URI: emptyToUndefined(z.string().url().optional()),
    /**
     * Same-origin path the browser lands on after a successful login when the
     * supplied `returnTo` is absent or fails the open-redirect guard.
     */
    BFF_POST_LOGIN_REDIRECT: z.string().default('/'),
    /** Server-side session lifetime in seconds. Defaults to 30 days. */
    BFF_SESSION_TTL_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .default(30 * SEC_PER_DAY),
    /**
     * HMAC key binding a CSRF token to the session that requested it, so a token
     * lifted from one session cannot be replayed in another.
     *
     * Distinct from COOKIE_SECRET on purpose: that one signs every cookie the app
     * sets, so rotating it invalidates all of them. Sharing one value would make a
     * cookie-hygiene rotation read as a CSRF change in the audit trail, and vice
     * versa.
     */
    CSRF_SECRET: z.string().min(32),

    // ── AWS (optional in dev) ──────────────────────────────────────────────────
    AWS_REGION: z.string().default('ap-southeast-1'),
    /** LocalStack/local-dev endpoint for the AWS SDK clients (SES, SQS). Unset in AWS. */
    AWS_ENDPOINT_URL: z.string().optional(),
    /**
     * The SQS queue BounceFeedbackService drains for SES bounce/complaint verdicts.
     * OPTIONAL and the consumer's OFF switch: unset = no consumer starts. Pairs with
     * SES_CONFIGURATION_SET above — the set tags the send, this is where the verdict lands.
     */
    SES_BOUNCE_QUEUE_URL: z.string().default(''),
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
    LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
    LOG_PRETTY: booleanish(false),
    LOG_SQL: booleanish(false),
    OTEL_ENABLED: booleanish(false),
    OTEL_SERVICE_NAME: z.string().default('opshub-api'),
    OTEL_WORKER_SERVICE_NAME: z.string().default('opshub-worker'),
    OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),

    // ── Cache (Valkey / Redis — optional in dev) ───────────────────────────────
    REDIS_URL: z.string().optional(),
    /** Alias for REDIS_URL injected by infra as VALKEY_URL. Resolved into REDIS_URL at startup. */
    VALKEY_URL: z.string().optional(),
    REDIS_KEY_PREFIX: z.string().default('opshub:'),

    // ── Background jobs ────────────────────────────────────────────────────────
    /** Audit log retention in days (SOC 2 baseline: 730 = 2 years). */
    AUDIT_RETENTION_DAYS: z.coerce.number().int().positive().default(730),

    // ── AI assistant (optional) ────────────────────────────────────────────────
    // When ANTHROPIC_API_KEY is unset the AI module reports itself disabled
    // (AiService.isEnabled()) and the /ai endpoints return 503.
    ANTHROPIC_API_KEY: z.string().optional(),
    ANTHROPIC_MODEL: z.string().default('claude-opus-4-8'),

    // ── Email ──────────────────────────────────────────────────────────────────
    /**
     * Which transport actually sends.
     *
     * `ses` is the one to reach for: it is in the same AWS account as everything else and
     * authenticates with the task role, so there is no third-party account and no API key in a secret.
     * `resend` stays because it is a working transport and removing it would be a decision about
     * vendors rather than about code. `dev` logs to the console and sends nothing, which is the default
     * so that a fresh checkout needs no mail setup at all.
     */
    EMAIL_PROVIDER: z.enum(['dev', 'resend', 'ses']).default('dev'),
    MAIL_FROM_NAME: z.string().default('OpsHub'),
    /**
     * NO DEFAULT, deliberately — see the refusal in the `superRefine` below.
     *
     * This defaulted to `no-reply@opshub.app`, a domain a given deployment may not own. So a
     * production configured with `EMAIL_PROVIDER=resend` and no sender did not fail: it sent from an
     * address that fails SPF and DKIM at the receiving end, which is silent non-delivery or delivery
     * to spam, and nothing in our logs explains either. The sibling repo added the same refusal after
     * finding both of its deployed environments running exactly that way.
     */
    MAIL_FROM_EMAIL: z.string().email().optional(),
    MAIL_REPLY_TO: z.string().email().optional(),
    RESEND_API_KEY: z.string().optional(),
    /**
     * The SES configuration set to tag every send with.
     *
     * Optional, and what it buys is attribution rather than delivery: without one, a bounce or
     * complaint arrives as an event nobody can tie back to the message that caused it. Sends work
     * either way, which is exactly why this is easy to leave unset and regret later.
     */
    SES_CONFIGURATION_SET: z.string().optional(),

    // ── Frontend ───────────────────────────────────────────────────────────────
    /** Public base URL used to build links inside notification emails. */
    APP_URL: z.string().url().default('http://localhost:5173'),
  })
  .superRefine((env, ctx) => {
    // A RATE LIMIT TESTS CAN RAISE IS NOT A CONTROL. The knob exists for CI; production keeps the
    // shipped ceiling, and this refusal is what makes that a rule rather than a comment. Deliberately
    // placed above the early return below, for the reason that comment gives.
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
    if (env.EMAIL_PROVIDER !== 'dev' && !env.MAIL_FROM_EMAIL) {
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
    // (rally's equivalent storage-pair check sits after its return and is inert there.)
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
  })
  .transform((env, ctx) => {
    // VALKEY_URL is the infra-injected alias for Redis-compatible caches (e.g. ElastiCache
    // Valkey). Normalize at parse time so all callers use get('REDIS_URL') regardless of
    // which var infra sets.
    const normalized = { ...env, REDIS_URL: env.VALKEY_URL ?? env.REDIS_URL };

    // JWT_PUBLIC_KEY is DERIVED, not configured.
    //
    // Storing the public half alongside the private one invites the single failure a
    // key pair cannot otherwise have: a MISMATCHED pair, where signing succeeds and
    // every verification rejects — total auth outage. Nothing catches it, because both
    // values are individually valid to Terraform, to the deploy preflight, and to this
    // schema. Deriving removes the possibility rather than monitoring for it.
    //
    // An explicit value still wins, so a local .env with a real pair keeps working and
    // infra can keep injecting one through the transition.
    // Restated rather than `return normalized`, and not redundantly: inside this guard
    // TS narrows the property to `string`, which is what makes JWT_PUBLIC_KEY
    // non-optional on the inferred Env type. Returning the object unchanged leaves it
    // `string | undefined` and every consumer needs a non-null assertion.
    if (normalized.JWT_PUBLIC_KEY) {
      return { ...normalized, JWT_PUBLIC_KEY: normalized.JWT_PUBLIC_KEY };
    }

    const reject = (message: string) => {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['JWT_PRIVATE_KEY'], message });
      return z.NEVER;
    };

    // createPrivateKey FIRST, deliberately. createPublicKey happily accepts a public
    // key as its input and hands it straight back, so deriving from it would silently
    // succeed for the likeliest paste error there is — the public half dropped into the
    // private slot — and fail much later at the first sign().
    let privateKey;
    try {
      privateKey = createPrivateKey(normalized.JWT_PRIVATE_KEY);
    } catch {
      return reject(
        'JWT_PRIVATE_KEY is PEM but not a PRIVATE key. A public key pasted here would ' +
          'pass the format check and then break signing at runtime.',
      );
    }

    // ES256 means P-256 specifically. Any other curve signs happily and produces
    // tokens every verifier rejects, which reads as a broken deploy with no cause.
    const curve = privateKey.asymmetricKeyDetails?.namedCurve;
    if (privateKey.asymmetricKeyType !== 'ec' || curve !== 'prime256v1') {
      return reject(
        `JWT_PRIVATE_KEY must be an EC P-256 key for ES256, got ` +
          `${privateKey.asymmetricKeyType}${curve ? `/${curve}` : ''}.`,
      );
    }

    return {
      ...normalized,
      // Derived from the validated PEM rather than the KeyObject: @types/node's
      // createPublicKey overloads do not accept a bare KeyObject, though the runtime
      // does. Re-exporting keeps this typed without a cast.
      JWT_PUBLIC_KEY: createPublicKey(
        privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      )
        .export({ type: 'spki', format: 'pem' })
        .toString(),
    };
  });

export type Env = z.infer<typeof EnvSchema>;
