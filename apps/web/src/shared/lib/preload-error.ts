/**
 * Reload once on `vite:preloadError`.
 *
 * After a deploy the content-hashed chunk names change; a tab still holding the old
 * entry asks for a chunk that no longer exists and Vite fires `vite:preloadError`.
 * One reload picks up the new entry. The sessionStorage flag keeps it at exactly one:
 * the flag is set before reloading and cleared on the next successful boot, so if the
 * error survives a reload (an outage, not a stale entry) the listener stands down
 * instead of looping.
 */
const RELOADED_KEY = 'opshub-vite-preload-reloaded';

export function registerPreloadErrorReload(target: Window = window): void {
  if (target.sessionStorage.getItem(RELOADED_KEY) === '1') {
    target.sessionStorage.removeItem(RELOADED_KEY);
    return;
  }
  target.addEventListener('vite:preloadError', () => {
    target.sessionStorage.setItem(RELOADED_KEY, '1');
    target.location.reload();
  });
}
