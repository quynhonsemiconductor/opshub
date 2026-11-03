/**
 * Boot: fetch and validate `/config.json` FIRST, then load the application.
 *
 * The order is the contract. App modules read `ENV` once, when they are first imported
 * (`shared/config/env.ts`), so they must not be evaluated before the runtime config is applied —
 * which is why `main.tsx` loads the app with a dynamic `import()` AFTER `loadConfig` resolves,
 * instead of importing `AppProviders` at the top of the file.
 *
 * Neither failure may leave the window blank: a missing or invalid config, and a failed load of the
 * app chunk itself (a deploy that replaced the hashed files under an open page), both render the
 * startup error screen.
 */
import { loadConfig } from '@/shared/config/config';
import {
  APP_ERROR_DESCRIPTION,
  CONFIG_ERROR_DESCRIPTION,
  renderStartupError,
} from './startup-error';

/** The app, loaded after the config: `bootstrap.tsx` exports `render`. */
export type AppLoader = () => Promise<{ render: (root: HTMLElement) => void }>;

export interface BootOptions {
  root: HTMLElement;
  /** Injected by the unit tests; the app uses `fetch`. */
  fetchImpl?: typeof fetch;
  loadApp: AppLoader;
}

export async function boot({ root, fetchImpl, loadApp }: BootOptions): Promise<void> {
  try {
    await loadConfig(fetchImpl);
  } catch (error) {
    renderStartupError(root, error, CONFIG_ERROR_DESCRIPTION);
    return;
  }

  let app: Awaited<ReturnType<AppLoader>>;
  try {
    app = await loadApp();
  } catch (error) {
    renderStartupError(root, error, APP_ERROR_DESCRIPTION);
    return;
  }
  app.render(root);
}
