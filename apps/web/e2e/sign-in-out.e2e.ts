import { request } from '@playwright/test';
import { test, expect } from './support/test';
import { gotoInShell } from './support/fixtures';

/**
 * The two browser journeys identity 8 changed: starting a Microsoft sign-in, and signing out.
 *
 * Everything else in this suite starts from a session `global-setup` minted with `/api/auth/test-login`, so
 * neither journey is otherwise exercised through the UI. These talk to the REAL API through the Vite proxy
 * (`/api/auth` is proxied like `/v1`), and stop where only Microsoft could continue: no Entra tenant exists
 * in CI or locally, so the redirect to `login.microsoftonline.com` is intercepted and asserted, not followed.
 */

test.describe('sign in', () => {
  // The saved seat session would send the visitor straight into the shell; this is the signed-out visitor.
  test.use({ storageState: { cookies: [], origins: [] } });

  test('Sign in with Microsoft starts the flow and hands the browser to Entra', async ({
    page,
  }) => {
    const startRequests: Array<{ body: unknown; method: string }> = [];
    page.on('request', (req) => {
      if (req.url().endsWith('/api/auth/sign-in/social')) {
        startRequests.push({ method: req.method(), body: req.postDataJSON() });
      }
    });
    let reachedEntra: string | undefined;
    await page.route(/login\.microsoftonline\.com/, async (route) => {
      reachedEntra = route.request().url();
      await route.abort();
    });

    await page.goto('/login?returnTo=%2Fassets');
    await page.getByRole('button', { name: /sign in with microsoft/i }).click();

    await expect.poll(() => reachedEntra, { timeout: 15_000 }).toBeDefined();
    expect(startRequests).toHaveLength(1);
    expect(startRequests[0]?.method).toBe('POST');
    expect(startRequests[0]?.body).toEqual({ provider: 'microsoft', callbackURL: '/assets' });
    const authorize = new URL(reachedEntra!);
    // the redirect URI is the SPA host's /api/auth/callback/microsoft: the one registered on the Entra app
    expect(authorize.searchParams.get('redirect_uri')).toMatch(/\/api\/auth\/callback\/microsoft$/);
    expect(authorize.searchParams.get('code_challenge'), 'PKCE').toBeTruthy();
  });

  test('refuses to carry an off-site returnTo into the flow', async ({ page }) => {
    let body: unknown;
    page.on('request', (req) => {
      if (req.url().endsWith('/api/auth/sign-in/social')) body = req.postDataJSON();
    });
    await page.route(/login\.microsoftonline\.com/, (route) => route.abort());

    await page.goto('/login?returnTo=https%3A%2F%2Fevil.example%2Fphish');
    await page.getByRole('button', { name: /sign in with microsoft/i }).click();

    await expect.poll(() => body, { timeout: 15_000 }).toBeDefined();
    expect(body).toEqual({ provider: 'microsoft', callbackURL: '/' });
  });
});

test.describe('sign out', () => {
  test('ends the server-side session, not only the tab', async ({ browser }) => {
    // A session of its OWN: signing out deletes the session row, and the shared seat sessions are reused by
    // every other spec in the run.
    const api = await request.newContext({ baseURL: 'http://localhost:5173' });
    const login = await api.post('/api/auth/test-login', {
      data: { email: 'employee@opshub.local' },
      headers: { origin: 'http://localhost:5173' },
    });
    expect(login.ok(), await login.text()).toBe(true);
    const context = await browser.newContext({ storageState: await api.storageState() });
    const page = await context.newPage();
    try {
      await gotoInShell(page, '/');
      const before = await context.request.get('http://localhost:5173/v1/auth/me');
      expect(before.status()).toBe(200);

      await page.getByRole('button', { name: /sign out/i }).click();
      await expect(page).toHaveURL(/\/login/);

      // The same cookie, replayed: the row is gone, so the API refuses it.
      const after = await api.get('/v1/auth/me');
      expect(after.status(), 'the session survived sign-out on the server').toBe(401);
    } finally {
      await context.close();
      await api.dispose();
    }
  });
});
