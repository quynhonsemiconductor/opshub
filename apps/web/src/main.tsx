/**
 * The SPA's entry point.
 *
 * It loads NO app code itself: `app/boot.ts` fetches `/config.json`, validates it and fills `ENV`
 * first, and only then does this file `import('./bootstrap')`. Keep the static imports here to plain
 * modules that read no configuration — an early import of `AppProviders` would evaluate the module
 * graph (the router, the API client) before the config exists.
 */
import { boot } from './app/boot';
// The stylesheet is static so the build links it in index.html: the first paint (and the config error
// screen) then has the app's colours instead of waiting for the app chunk.
import './app/styles/globals.css';

const root = document.getElementById('root');

if (!root) {
  throw new Error('The SPA entry is missing #root in index.html');
}

void boot({ root, loadApp: () => import('./bootstrap') });
