// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { boot } from './boot';
import { APP_ERROR_DESCRIPTION, STARTUP_ERROR_TITLE } from './startup-error';
import { ENV } from '@/shared/config/env';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const VALID = { apiBaseUrl: '', appEnv: 'production', devLoginEnabled: false } as const;

let root: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>';
  root = document.getElementById('root')!;
  ENV.APP_ENV = 'production';
  ENV.DEV_LOGIN_ENABLED = false;
});

describe('boot', () => {
  it('boots the app once a valid config is applied', async () => {
    const render = vi.fn();
    const loadApp = vi.fn().mockResolvedValue({ render });

    await boot({ root, fetchImpl: vi.fn().mockResolvedValue(jsonResponse(VALID)), loadApp });

    expect(loadApp).toHaveBeenCalledTimes(1);
    expect(render).toHaveBeenCalledWith(root);
    // The app is loaded only after the config reached ENV: a module reads it once, at import.
    expect(ENV.APP_ENV).toBe('production');
  });

  it('shows an error screen, not a blank page, when the config is missing', async () => {
    const loadApp = vi.fn();

    await boot({
      root,
      fetchImpl: vi.fn().mockResolvedValue(new Response('', { status: 404 })),
      loadApp,
    });

    expect(loadApp).not.toHaveBeenCalled();
    expect(root.textContent).toContain(STARTUP_ERROR_TITLE);
    expect(root.textContent).toContain('HTTP 404');
    expect(root.querySelector('[data-testid="startup-error"]')).not.toBeNull();
  });

  it('shows the error screen when the config is invalid', async () => {
    const loadApp = vi.fn();

    await boot({
      root,
      fetchImpl: vi
        .fn()
        .mockResolvedValue(jsonResponse({ apiBaseUrl: '', appEnv: 'dev', devLoginEnabled: false })),
      loadApp,
    });

    expect(loadApp).not.toHaveBeenCalled();
    expect(root.textContent).toContain(STARTUP_ERROR_TITLE);
    expect(root.textContent).toContain('appEnv');
  });

  it('shows the error screen, not a blank page, when the app chunk fails to load', async () => {
    const loadApp = vi
      .fn()
      .mockRejectedValue(new Error('Failed to fetch dynamically imported module'));

    await boot({ root, fetchImpl: vi.fn().mockResolvedValue(jsonResponse(VALID)), loadApp });

    expect(root.textContent).toContain(STARTUP_ERROR_TITLE);
    expect(root.textContent).toContain(APP_ERROR_DESCRIPTION);
    expect(root.textContent).toContain('Failed to fetch dynamically imported module');
    expect(root.querySelector('[data-testid="startup-error"]')).not.toBeNull();
  });
});
