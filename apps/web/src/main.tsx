import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AppProviders } from '@/app/providers/app-providers';
import { initTheme } from '@/shared/lib/theme';
import '@/app/styles/globals.css';
import { registerPreloadErrorReload } from '@/shared/lib/preload-error';

// Apply the theme class before first paint to avoid a flash of the wrong theme.
initTheme();

registerPreloadErrorReload();

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Root element #root not found');

createRoot(rootEl).render(
  <StrictMode>
    <AppProviders />
  </StrictMode>,
);
