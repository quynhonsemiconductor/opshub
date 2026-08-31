import { useState } from 'react';
import { toast } from 'sonner';
import { ENV } from '@/shared/config/env';
import { sessionFetch } from '@/shared/api/session-fetch';

function OpsHubMark({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <rect width="32" height="32" rx="7" fill="#2563eb" />
      <path
        d="M16 7C11.03 7 7 11.03 7 16s4.03 9 9 9 9-4.03 9-9-4.03-9-9-9Zm0 13.5A4.5 4.5 0 1 1 16 11.5a4.5 4.5 0 0 1 0 9Z"
        fill="white"
      />
    </svg>
  );
}

/**
 * Sign-in page. One button, because there is one directory: the company Entra tenant.
 *
 * The SPA never sees a token. `POST /v1/bff/login` starts the Authorization-Code + PKCE
 * flow SERVER-side and returns the Entra authorize URL; the browser is then handed to
 * Microsoft, and comes back to `/v1/bff/callback`, which mints a server-side session and
 * sets the opaque `__Host-opshub_session` cookie before redirecting here-ward.
 *
 * `window.location.assign`, not the router: this is a top-level navigation to a different
 * origin, and it must be a real document load so Entra can set its own cookies and return
 * through the redirect chain.
 */
export function LoginPage() {
  const [loading, setLoading] = useState(false);

  async function onSignIn() {
    setLoading(true);
    // returnTo is validated server-side against an open-redirect guard, so a hostile
    // value cannot bounce the browser off-site — it falls back to BFF_POST_LOGIN_REDIRECT.
    const returnTo = new URLSearchParams(window.location.search).get('returnTo') ?? '/';
    // Raw fetch, not the generated client: the BFF controller is @ApiExcludeController,
    // so these browser-redirect routes are deliberately absent from the OpenAPI document
    // and from the typed client built off it.
    try {
      const res = await sessionFetch(`${ENV.API_BASE_URL}/v1/bff/login`, {
        method: 'POST',
        body: JSON.stringify({ returnTo }),
      });
      if (!res.ok) throw new Error(`login start failed (${res.status})`);
      const { authorizeUrl } = (await res.json()) as { authorizeUrl: string };
      window.location.assign(authorizeUrl);
    } catch {
      setLoading(false);
      toast.error('Could not start sign-in. Please try again or contact IT.');
    }
  }

  return (
    <div className="flex min-h-[100dvh]">
      {/* Left: brand panel (always dark) */}
      <div className="hidden w-[400px] shrink-0 flex-col justify-between bg-sidebar p-10 lg:flex">
        <div className="flex items-center gap-3">
          <OpsHubMark size={32} />
          <span className="text-base font-semibold tracking-tight text-sidebar-fg-active">
            OpsHub
          </span>
        </div>
        <div className="flex flex-col gap-6">
          <div>
            <h1 className="text-2xl font-semibold leading-snug tracking-tight text-sidebar-fg-active">
              Internal Ops Platform
            </h1>
            <p className="mt-2 text-sm leading-relaxed text-sidebar-fg">
              One portal for IT and HR to manage the full lifecycle of employees, devices, software,
              access, and time.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {['People', 'Devices', 'Access', 'Compliance', 'Workforce'].map((tag) => (
              <span
                key={tag}
                className="rounded-md border border-sidebar-border px-2.5 py-1 text-xs text-sidebar-fg"
              >
                {tag}
              </span>
            ))}
          </div>
        </div>
        <p className="text-xs text-sidebar-label">
          Access is managed by IT. Contact your administrator if you cannot sign in.
        </p>
      </div>

      {/* Right: dev login form */}
      <div className="flex flex-1 flex-col items-center justify-center bg-linear-to-b from-surface to-page px-6 py-12">
        <div className="mb-8 flex items-center gap-2.5 lg:hidden">
          <OpsHubMark size={28} />
          <span className="text-base font-semibold tracking-tight text-fg">OpsHub</span>
        </div>

        <div className="w-full max-w-[360px] animate-fade-up">
          <div className="mb-7">
            <h2 className="text-lg font-semibold tracking-tight text-fg">Sign in</h2>
            <p className="mt-1 text-sm text-fg-muted">Use your company Microsoft account.</p>
          </div>

          <button
            type="button"
            onClick={onSignIn}
            disabled={loading}
            className="flex h-9 w-full items-center justify-center gap-2 rounded-md bg-accent text-sm font-medium text-accent-fg transition hover:bg-accent-hover active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60 focus:outline-none focus:ring-2 focus:ring-accent/40 focus:ring-offset-1 focus:ring-offset-surface"
          >
            {loading ? 'Redirecting…' : 'Sign in with Microsoft'}
          </button>
        </div>
      </div>
    </div>
  );
}
