/**
 * Reload once on `vite:preloadError`.
 *
 * After a deploy the content-hashed chunk names change; a tab still holding the old
 * entry asks for a chunk that no longer exists and Vite fires `vite:preloadError`.
 * One reload picks up the new entry. The sessionStorage flag keeps it at exactly one:
 * the flag is set before reloading and cleared on the next successful boot, so if the
 * error survives a reload (an outage, not a stale entry) the listener stands down
 * instead of looping.
 *
 * Every sessionStorage access is guarded: browsers throw a SecurityError wherever
 * storage is blocked (hardened privacy settings, embedded frames), and an unguarded
 * throw at module scope means a WHITE SCREEN. Where the flag cannot be read or
 * written, the listener stands down — an endless reload loop would be worse than a
 * stale chunk.
 */
const RELOADED_KEY = 'opshub-vite-preload-reloaded';

export function registerPreloadErrorReload(target: Window = window): void {
  try {
    if (target.sessionStorage.getItem(RELOADED_KEY) === '1') {
      target.sessionStorage.removeItem(RELOADED_KEY);
      return;
    }
  } catch {
    // Storage unavailable: no flag can ever be written, so a reload would loop.
    return;
  }
  target.addEventListener('vite:preloadError', () => {
    try {
      target.sessionStorage.setItem(RELOADED_KEY, '1');
    } catch {
      // Cannot mark the reload as done — reloading again would loop. Do nothing.
      return;
    }
    target.location.reload();
  });
}
