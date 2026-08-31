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

/** The four-square Microsoft mark — the one piece of a "Sign in with Microsoft" button every
 * real implementation carries, and the one this was missing. Fixed brand colours, not tokens:
 * this identifies Microsoft, not this app, so it does not follow the theme. */
function MicrosoftMark() {
  return (
    <svg width={16} height={16} viewBox="0 0 21 21" aria-hidden="true">
      <rect x="1" y="1" width="9" height="9" fill="#f25022" />
      <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
      <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
      <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
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
      {/* Left: brand panel — a layered accent glow + dot grid, not flat colour, so the first
          thing anyone sees reads as designed rather than default. */}
      <div className="relative hidden w-[440px] shrink-0 flex-col justify-between overflow-hidden bg-sidebar p-10 lg:flex">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 [background-image:radial-gradient(circle_at_1px_1px,var(--border-sidebar)_1px,transparent_0)] [background-size:22px_22px] opacity-40"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -left-24 -top-24 h-96 w-96 rounded-full bg-accent opacity-20 blur-3xl"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -bottom-32 -right-16 h-96 w-96 rounded-full bg-accent-secondary opacity-20 blur-3xl"
        />

        <div className="relative flex items-center gap-3">
          <OpsHubMark size={32} />
          <span className="text-base font-semibold tracking-tight text-sidebar-fg-active">
            OpsHub
          </span>
        </div>
        <div className="relative flex flex-col gap-6">
          <div>
            <h1 className="text-display font-semibold text-sidebar-fg-active">
              Internal Ops Platform
            </h1>
            <p className="mt-3 text-sm leading-relaxed text-sidebar-fg">
              One portal for IT and HR to manage the full lifecycle of employees, devices, software,
              access, and time.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {['People', 'Devices', 'Access', 'Compliance', 'Workforce'].map((tag) => (
              <span
                key={tag}
                className="rounded-md border border-sidebar-border bg-sidebar-active/40 px-2.5 py-1 text-xs text-sidebar-fg"
              >
                {tag}
              </span>
            ))}
          </div>
        </div>
        <p className="relative text-xs text-sidebar-label">
          Access is managed by IT. Contact your administrator if you cannot sign in.
        </p>
      </div>

      {/* Right: sign-in card */}
      <div className="flex flex-1 flex-col items-center justify-center bg-linear-to-b from-surface to-page px-6 py-12">
        <div className="mb-8 flex items-center gap-2.5 lg:hidden">
          <OpsHubMark size={28} />
          <span className="text-base font-semibold tracking-tight text-fg">OpsHub</span>
        </div>

        <div className="w-full max-w-[380px] animate-fade-up">
          <div className="rounded-xl border border-border bg-surface p-7 shadow-lg">
            <div className="mb-6 flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent-muted">
                <OpsHubMark size={20} />
              </div>
              <div>
                <h2 className="text-lg font-semibold tracking-tight text-fg">Sign in</h2>
                <p className="text-sm text-fg-muted">Use your company Microsoft account</p>
              </div>
            </div>

            <button
              type="button"
              onClick={onSignIn}
              disabled={loading}
              className="flex h-10 w-full items-center justify-center gap-2.5 rounded-md border border-border bg-surface text-sm font-medium text-fg shadow-sm transition-colors hover:bg-surface-hover active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60 focus:outline-none focus:ring-2 focus:ring-accent/40 focus:ring-offset-1 focus:ring-offset-surface"
            >
              {loading ? (
                'Redirecting…'
              ) : (
                <>
                  <MicrosoftMark />
                  Sign in with Microsoft
                </>
              )}
            </button>
          </div>

          <p className="mt-5 text-center text-xs text-fg-subtle lg:hidden">
            Access is managed by IT. Contact your administrator if you cannot sign in.
          </p>
        </div>
      </div>
    </div>
  );
}
