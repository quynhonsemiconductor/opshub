/**
 * Theme store — light / dark / system, class-driven (html.dark).
 *
 * Default is `system` (follows OS). The first manual toggle persists an explicit
 * choice in localStorage. `initTheme()` must run synchronously before render to
 * apply the class and avoid a flash of the wrong theme (FOUC).
 */
import { create } from 'zustand';

export type ThemeMode = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'opshub-theme';

function systemPrefersDark(): boolean {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}

function resolve(mode: ThemeMode): ResolvedTheme {
  return mode === 'system' ? (systemPrefersDark() ? 'dark' : 'light') : mode;
}

function applyClass(resolved: ResolvedTheme): void {
  document.documentElement.classList.toggle('dark', resolved === 'dark');
}

interface ThemeState {
  mode: ThemeMode;
  resolved: ResolvedTheme;
  /** Set an explicit mode (or 'system'); applies + persists. */
  setMode: (mode: ThemeMode) => void;
  /** Flip between light and dark based on what's currently shown. */
  toggle: () => void;
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  mode: 'system',
  resolved: 'light',
  setMode: (mode) => {
    const resolved = resolve(mode);
    applyClass(resolved);
    try {
      localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      /* storage may be blocked on locked-down enterprise machines */
    }
    set({ mode, resolved });
  },
  toggle: () => {
    get().setMode(get().resolved === 'dark' ? 'light' : 'dark');
  },
}));

/** Run once at startup, before React renders. */
export function initTheme(): void {
  let mode: ThemeMode = 'system';
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') mode = stored;
  } catch {
    /* ignore */
  }
  const resolved = resolve(mode);
  applyClass(resolved);
  useThemeStore.setState({ mode, resolved });

  // Track OS changes while the user is on `system`.
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (useThemeStore.getState().mode !== 'system') return;
    const next = resolve('system');
    applyClass(next);
    useThemeStore.setState({ resolved: next });
  });
}
