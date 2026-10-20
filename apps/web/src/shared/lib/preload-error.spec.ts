import { describe, expect, it, vi } from 'vitest';
import { registerPreloadErrorReload } from './preload-error';

function fakeWindow(store = new Map<string, string>()) {
  let handler: () => void = () => {};
  return {
    store,
    sessionStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    },
    addEventListener: (_type: string, listener: () => void) => {
      handler = listener;
    },
    location: { reload: vi.fn() },
    fire: () => handler(),
  };
}

describe('registerPreloadErrorReload', () => {
  it('reloads the first time vite:preloadError fires', () => {
    const win = fakeWindow();
    registerPreloadErrorReload(win as unknown as Window);
    win.fire();
    expect(win.location.reload).toHaveBeenCalledTimes(1);
    expect(win.store.get('opshub-vite-preload-reloaded')).toBe('1');
  });

  it('does not reload again while the session flag survives a reload', () => {
    const first = fakeWindow();
    registerPreloadErrorReload(first as unknown as Window);
    first.fire();

    // The reloaded page boots with the flag still set: no new listener, no reload.
    const second = fakeWindow(first.store);
    registerPreloadErrorReload(second as unknown as Window);
    second.fire();
    expect(second.location.reload).not.toHaveBeenCalled();
    expect(second.store.has('opshub-vite-preload-reloaded')).toBe(false);
  });
});
