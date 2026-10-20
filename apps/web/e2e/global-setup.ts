import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { request } from '@playwright/test';
import { AUTH_STATES, SEAT_EMAILS } from './support/fixtures';

/**
 * Sign in ONCE and save the session cookie for every spec to reuse.
 *
 * HOW, AND WHY NOT THROUGH THE UI: OpsHub's login page is a single Entra SSO button — there is
 * no passwordless form for a browser to fill, because the product has exactly one directory.
 * rova renders a dev-login form behind a Vite flag and drives it; adding one here would be a
 * production UI change made for a test.
 *
 * So this posts to `/api/auth/test-login` (identity 8; it loads only with IDENTITY_TEST_LOGIN=enabled and
 * NODE_ENV `development`/`test`) through Playwright's request context. The API replies with
 * `Set-Cookie: opshub.session_token` (`__Host-` in production), and because the request
 * goes to the Vite origin the cookie is stored for `localhost:5174` — exactly as a real login
 * leaves it. Nothing is forged: no cookie is hand-assembled and no token is injected into the
 * page, which is what makes this a real session rather than a lookalike.
 *
 * The SPA then hydrates from that cookie on its own: `auth-bootstrap.ts` calls
 * `GET /v1/auth/me`, so there is no client state to seed either.
 */
export default async function globalSetup(): Promise<void> {
  // ONE SESSION PER SEAT. The suite spreads its spec files across these identities so no single one
  // crosses the DEFAULT rate-limit tier — see `AUTH_STATES`.
  for (const [index, email] of SEAT_EMAILS.entries()) {
    await signIn(email, AUTH_STATES[index]);
  }
}

async function signIn(email: string, statePath: string): Promise<void> {
  const api = await request.newContext({ baseURL: 'http://localhost:5174' });

  // Origin: the same header the browser sends; Better Auth checks it on every write.
  const res = await api.post('/api/auth/test-login', {
    data: { email },
    headers: { origin: 'http://localhost:5174' },
  });
  if (!res.ok()) {
    throw new Error(
      `test-login failed for ${email}: ${res.status()} ${await res.text()}\n` +
        'Is the API running on :3001, the database seeded (`pnpm db:migrate`), and NODE_ENV ' +
        'something other than production, and IDENTITY_TEST_LOGIN=enabled? `/api/auth/test-login` is ' +
        'refused in production by design.',
    );
  }

  // Fail loudly here rather than in every spec: a 2xx with no cookie would save an empty state
  // and each test would then fail on its own first assertion, pointing at the screen instead of
  // at the login.
  const { cookies } = await api.storageState();
  const session = cookies.find((c) => c.name.includes('opshub.session_token'));
  if (!session) {
    throw new Error(
      `test-login returned ${res.status()} but set no session cookie. Cookies seen: ` +
        `${cookies.map((c) => c.name).join(', ') || '(none)'}`,
    );
  }

  await mkdir(dirname(statePath), { recursive: true });
  await api.storageState({ path: statePath });
  await api.dispose();
}
