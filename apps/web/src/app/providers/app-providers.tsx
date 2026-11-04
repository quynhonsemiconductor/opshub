import { Component, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { Toaster } from 'sonner';
import { router } from '@/app/router/router';
import { bootstrapAuth, resetBootstrap } from '@/shared/api/auth-bootstrap';
import { useAuthStore } from '@/shared/api/auth-store';
import { queryClient } from '@/shared/api/query-client';
import { useThemeStore } from '@/shared/lib/theme';

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            height: '100dvh',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '12px',
            fontFamily: 'sans-serif',
            color: '#374151',
          }}
        >
          <p style={{ fontWeight: 600, fontSize: '16px' }}>Something went wrong</p>
          <p style={{ fontSize: '13px', color: '#6b7280' }}>
            {(this.state.error as Error).message}
          </p>
          <button
            onClick={() => window.location.reload()}
            style={{
              padding: '6px 16px',
              border: '1px solid #d1d5db',
              borderRadius: '6px',
              cursor: 'pointer',
              background: '#fff',
              fontSize: '13px',
            }}
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

/**
 * Full-screen loader. Shown while the session is being resolved, and during a retry, so the app
 * never flashes the login page for a session it has not disproved.
 */
function Loading() {
  return (
    <div
      style={{
        display: 'flex',
        height: '100dvh',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--bg-page)',
      }}
    >
      <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-label="Loading OpsHub">
        <rect width="22" height="22" rx="5" fill="#2563eb" opacity="0.7" />
        <path
          d="M11 5.5C7.96 5.5 5.5 7.96 5.5 11s2.46 5.5 5.5 5.5 5.5-2.46 5.5-5.5S14.04 5.5 11 5.5Zm0 8.25a2.75 2.75 0 1 1 0-5.5 2.75 2.75 0 0 1 0 5.5Z"
          fill="white"
        />
      </svg>
    </div>
  );
}

/**
 * A session that could not be verified is NOT a signed-out session.
 *
 * Before this screen existed, a 429/5xx/offline bootstrap cleared the auth store and the router sent
 * the user to the login page even though the session cookie was still valid. Offering a retry keeps
 * the distinction the store now makes: the cookie is unproven, not gone.
 */
function BootstrapFailure({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div
      style={{
        display: 'flex',
        height: '100dvh',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--bg-page)',
      }}
    >
      <div
        role="alert"
        style={{
          display: 'flex',
          maxWidth: '360px',
          flexDirection: 'column',
          alignItems: 'center',
          gap: '12px',
          padding: '24px',
          textAlign: 'center',
          fontFamily: 'sans-serif',
          color: 'var(--text-primary)',
        }}
      >
        <p style={{ fontWeight: 600, fontSize: '16px' }}>OpsHub could not start</p>
        <p style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>{message}</p>
        <button
          onClick={onRetry}
          style={{
            padding: '6px 16px',
            border: '1px solid var(--color-border)',
            borderRadius: '6px',
            cursor: 'pointer',
            background: 'var(--bg-surface)',
            color: 'var(--text-primary)',
            fontSize: '13px',
          }}
        >
          Try again
        </button>
      </div>
    </div>
  );
}

/**
 * On first render, silently attempt to restore the session from the HttpOnly
 * refresh cookie before mounting the router. This prevents a flash-redirect to
 * /login on every page reload when the user still has a valid session.
 */
export function AppProviders() {
  const [ready, setReady] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const bootstrapError = useAuthStore((s) => s.error);
  const resolvedTheme = useThemeStore((s) => s.resolved);

  useEffect(() => {
    bootstrapAuth().finally(() => setReady(true));
  }, []);

  function retry(): void {
    setRetrying(true);
    resetBootstrap();
    void bootstrapAuth().finally(() => setRetrying(false));
  }

  if (!ready || retrying) return <Loading />;
  if (bootstrapError) return <BootstrapFailure message={bootstrapError} onRetry={retry} />;

  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
        <Toaster richColors position="top-right" theme={resolvedTheme} />
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
