/**
 * The SPA's runtime configuration: `/config.json`, fetched once before the app bootstraps.
 *
 * The bundle is built ONCE and promoted by digest, so nothing environment-specific may be compiled
 * into it. The deploying environment (gitops, per env) mounts a `config.json` next to `dist/`; this
 * module fetches it, validates every field, and only then hands control to the app. A missing or
 * invalid config is an ERROR SCREEN (`app/startup-error.ts`), never a blank page: the alternative is a
 * white window and a console nobody reads.
 *
 * The dev server answers `/config.json` itself (`vite.config.ts`, `devConfigPlugin`), so `pnpm dev`
 * needs no file and a build never contains one.
 */
import { z } from 'zod';
import { applyConfig } from './env';

/** Where the config is served, and where a deployment mounts it. Same-origin, always. */
export const CONFIG_PATH = '/config.json';

export type AppEnv = 'development' | 'staging' | 'production';

/**
 * `''` (same origin) or a path on this origin (`/api`). Absolute origins are deliberately refused:
 * the SPA must stay same-origin, because authentication rides a `__Host-` (production) /
 * `__Secure-` session cookie that a cross-site request would not carry, so a config naming another
 * origin can only be a mistake.
 *
 * The path is resolved against a dummy origin and must land back on it: `//evil` (protocol-relative)
 * and `/\evil` (a backslash is a slash to the URL parser) both leave it.
 */
const SAME_ORIGIN = 'http://same-origin.invalid';

function isApiBaseUrl(value: string): boolean {
  if (value === '') return true;
  if (!value.startsWith('/') || value.startsWith('//')) return false;
  try {
    return new URL(value, SAME_ORIGIN).origin === SAME_ORIGIN;
  } catch {
    return false;
  }
}

/**
 * The whole contract, and it is strict in the ways that matter: an unknown `appEnv`, a `"true"`
 * string instead of a boolean, or an `apiBaseUrl` that leaves this origin is a misconfigured
 * deployment, and it fails at boot rather than at the first request.
 *
 * The shape is the SAME for every product's web image (delivery design, section 3.1): one chart
 * renders one ConfigMap shape per environment, and the API/origin rules do not differ per SPA.
 */
export const configSchema = z.object({
  apiBaseUrl: z
    .string()
    .refine(
      isApiBaseUrl,
      'must be "" (same origin) or a path on this origin starting with a single "/"',
    ),
  appEnv: z.enum(['development', 'staging', 'production']),
  devLoginEnabled: z.boolean(),
  /**
   * The running web image tag, which the chart adds when it renders this ConfigMap (qnsc-service
   * 0.19.3). Optional on purpose: an older chart renders no tag, and the footer then shows only what
   * it knows. The chart's value wins over anything a product writes into `web.config` — the tag is
   * the fact, a copied string drifts.
   */
  appVersion: z.string().min(1).optional(),
  /** The commit a `sha-<commit>` web tag names; absent for a release tag or a digest-only pin. */
  appCommit: z.string().min(1).optional(),
});

export type AppConfig = z.infer<typeof configSchema>;

/** A config that could not be fetched or did not validate. The message is shown on the error screen. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Fetches and validates `/config.json`, then applies it to `ENV`. Callers must not import app modules
 * before this resolves: they read `ENV` once, at module load.
 *
 * `fetchImpl` is injectable for the unit tests; the app always uses `fetch`.
 */
export async function loadConfig(fetchImpl: typeof fetch = fetch): Promise<AppConfig> {
  let response: Response;
  try {
    // `no-store`: the file is small and must never be a stale cached copy (the server also sends
    // `Cache-Control: no-cache`, but a proxy is not the only cache to consider).
    response = await fetchImpl(CONFIG_PATH, {
      cache: 'no-store',
      headers: { accept: 'application/json' },
    });
  } catch (error) {
    throw new ConfigError(`Could not fetch ${CONFIG_PATH}: ${describe(error)}`);
  }

  if (!response.ok) {
    throw new ConfigError(
      `${CONFIG_PATH} answered HTTP ${response.status}. The deployment must mount it next to the app.`,
    );
  }

  let raw: unknown;
  try {
    raw = await response.json();
  } catch (error) {
    throw new ConfigError(`${CONFIG_PATH} is not valid JSON: ${describe(error)}`);
  }

  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(`${CONFIG_PATH} is invalid:\n${z.prettifyError(parsed.error)}`);
  }

  applyConfig(parsed.data);
  return parsed.data;
}
