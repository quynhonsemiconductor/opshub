/**
 * The application entry: loaded by `main.tsx` with a dynamic `import()` once `/config.json` has been
 * fetched and applied (`app/boot.ts`). Everything here — the provider tree, the router, the API
 * client — may read `ENV` at import time, which is exactly why it is not statically imported by
 * `main.tsx`.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AppProviders } from '@/app/providers/app-providers';
import { initTheme } from '@/shared/lib/theme';
import { registerPreloadErrorReload } from '@/shared/lib/preload-error';

// Apply the theme class before first paint to avoid a flash of the wrong theme.
initTheme();

registerPreloadErrorReload();

export function render(root: HTMLElement): void {
  createRoot(root).render(
    <StrictMode>
      <AppProviders />
    </StrictMode>,
  );
}
