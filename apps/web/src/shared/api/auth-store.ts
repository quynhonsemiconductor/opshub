import { create } from 'zustand';

/** The authenticated principal, as returned by `GET /v1/auth/me`. */
export interface SessionUser {
  sub: string;
  email: string;
  name: string;
  /** Keys of the permission groups the user belongs to — for display, never for gating. */
  groups: string[];
  /**
   * Effective permission keys resolved from the database. `'*'` means super-admin. Gate
   * UI on THIS, never on `groups` — the server authorizes from the same list, so anything
   * derived from group names can drift out of agreement with it.
   */
  permissions: string[];
}

interface AuthState {
  user: SessionUser | null;
  /** False until the bootstrap has finished, so the router waits rather than guesses. */
  ready: boolean;
  /**
   * Why the session could not be resolved, when it could not be. A transient failure (429, 5xx,
   * offline) lands here instead of clearing `user`: the browser still holds the session cookie, and
   * only a 401/403 proves it is gone.
   */
  error: string | null;
  setUser: (user: SessionUser | null) => void;
  setReady: (ready: boolean) => void;
  setError: (error: string | null) => void;
  clear: () => void;
}

/**
 * Session state for the cookie flow (identity 8).
 *
 * There is NO token here, and that is the point. Authentication rides an opaque,
 * httpOnly opshub.session_token cookie (`__Host-` in production) the browser cannot read, so the SPA holds
 * nothing an XSS payload could exfiltrate and nothing it could accidentally log. This
 * store keeps only the identity the server reported, for rendering.
 *
 * It previously held a short-lived access JWT in the JS heap alongside a refresh cookie,
 * with a silent-refresh path and cross-tab Web Locks to stop two tabs replaying the same
 * single-use refresh token (which the server treats as theft and punishes by revoking the
 * whole family). All of that is gone: the server refreshes the underlying token behind
 * the session, so the browser has nothing left to coordinate.
 */
export const useAuthStore = create<AuthState>()((set) => ({
  user: null,
  ready: false,
  error: null,
  setUser: (user) => set({ user, error: null }),
  setReady: (ready) => set({ ready }),
  setError: (error) => set({ error }),
  clear: () => set({ user: null, error: null }),
}));

/** Whether a session is established. Read by the router guard. */
export function isAuthenticated(): boolean {
  return useAuthStore.getState().user !== null;
}
