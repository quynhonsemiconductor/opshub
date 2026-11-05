/**
 * The SPA's runtime environment, as the rest of the app reads it.
 *
 * The DEPLOYED values are not baked into the bundle: the SPA fetches `/config.json` once, before it
 * bootstraps (`shared/config/config.ts`), and `applyConfig` fills this object in. One image therefore
 * serves every environment, and a value changes with a ConfigMap, not a rebuild.
 *
 * `IS_DEV` is the exception: it is the Vite dev server itself (`import.meta.env.DEV`), a build-time
 * fact of the bundle, not an environment of the product.
 *
 * The defaults below are what a module sees when it is imported before (or without) a config — the
 * unit tests — and they match the old build-time defaults.
 *
 * `APP_ENV` and `DEV_LOGIN_ENABLED` are part of the shared config shape every product's web image
 * consumes, even though this SPA has no dev-login affordance today: one chart renders one ConfigMap
 * for all of them, and a product-specific shape would be the drift this contract exists to remove.
 *
 * Do NOT point `API_BASE_URL` at the API host. Same-origin is a requirement, not a preference:
 * identity 8 sets its `__Host-` (production) / `__Secure-` session cookie on the response the
 * browser lands on after Entra, on the SPA host; talking to the API directly would put the cookie on
 * another site and break login while appearing to work for unauthenticated requests.
 */
import type { AppConfig, AppEnv } from './config';

export interface Env {
  /**
   * The API origin prefix, e.g. `''` for same-origin (what every deployment uses) or a path on this
   * origin such as `/api`. Never an absolute origin, which the config schema refuses.
   */
  API_BASE_URL: string;
  APP_ENV: AppEnv;
  /** The Vite dev server (`vite`), never true in a build. */
  IS_DEV: boolean;
  /** The passwordless dev-login affordance. Off for OpsHub, which signs in through Entra only. */
  DEV_LOGIN_ENABLED: boolean;
  /**
   * The running web image tag and commit, when the chart rendered them into `/config.json`
   * (qnsc-service 0.19.3). Undefined under an older chart, and then the footer says only what it
   * knows rather than inventing a version.
   */
  APP_VERSION?: string;
  APP_COMMIT?: string;
}

export const ENV: Env = {
  API_BASE_URL: '',
  APP_ENV: 'development',
  IS_DEV: import.meta.env.DEV,
  DEV_LOGIN_ENABLED: false,
};

/** Fills `ENV` from a validated `/config.json`. Called once, by `loadConfig`. */
export function applyConfig(config: AppConfig): void {
  ENV.API_BASE_URL = config.apiBaseUrl;
  ENV.APP_ENV = config.appEnv;
  ENV.DEV_LOGIN_ENABLED = config.devLoginEnabled;
  ENV.APP_VERSION = config.appVersion;
  ENV.APP_COMMIT = config.appCommit;
}
