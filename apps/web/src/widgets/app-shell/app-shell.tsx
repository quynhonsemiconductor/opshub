import { useEffect, useState } from 'react';
import { ENV } from '@/shared/config/env';
import { Link, Outlet, useNavigate } from '@tanstack/react-router';
import {
  LogOut,
  ChevronRight,
  UserCircle2,
  Search,
  Sparkles,
  PanelLeftClose,
  PanelLeft,
} from 'lucide-react';
import { AiChatPanel } from '@/widgets/ai-chat/ai-chat-panel';
import { useAuthStore } from '@/shared/api/auth-store';
import { resetBootstrap } from '@/shared/api/auth-bootstrap';
import { setCsrfToken, withCsrfHeader } from '@/shared/api/csrf';
import { cn } from '@/shared/lib/utils';
import { NotificationBell } from '@/widgets/notifications/notification-bell';
import { CommandPalette } from '@/widgets/command-palette/command-palette';
import { useCommandPaletteStore } from '@/widgets/command-palette/use-command-palette';
import { useCurrentUser } from '@/shared/hooks/use-current-user';
import { usePermissions } from '@/shared/hooks/use-permissions';
import { Button } from '@/shared/ui';
import { ThemeToggle } from '@/shared/ui/theme-toggle';
import { FEATURES } from '@/shared/config/features';
import { navGroups } from './nav-groups';

function OpsHubMark() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true">
      <rect width="22" height="22" rx="5" fill="#2563eb" />
      <path
        d="M11 5.5C7.96 5.5 5.5 7.96 5.5 11s2.46 5.5 5.5 5.5 5.5-2.46 5.5-5.5S14.04 5.5 11 5.5Zm0 8.25a2.75 2.75 0 1 1 0-5.5 2.75 2.75 0 0 1 0 5.5Z"
        fill="white"
      />
    </svg>
  );
}

/** Avatar initials circle for the sidebar user footer. */
function AvatarChip({ name, email }: { name: string; email: string }) {
  const initials = name
    .split(' ')
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
  const colors = [
    'bg-blue-500',
    'bg-violet-500',
    'bg-emerald-500',
    'bg-amber-500',
    'bg-rose-500',
    'bg-cyan-500',
  ];
  const idx = [...email].reduce((acc, c) => acc + c.charCodeAt(0), 0) % colors.length;
  return (
    <span
      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${colors[idx]} text-2xs font-semibold text-white`}
    >
      {initials || '?'}
    </span>
  );
}

/** Sidebar bottom — link to My Profile, shows current user name. */
function UserFooter() {
  const { data: me } = useCurrentUser();
  return (
    <Link
      to="/profile"
      className={cn(
        'group flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors',
        'text-sidebar-fg hover:bg-sidebar-hover hover:text-sidebar-fg-active',
      )}
      activeProps={{
        className:
          'group flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm bg-sidebar-active text-sidebar-fg-active',
      }}
    >
      {me ? (
        <AvatarChip name={me.name} email={me.email} />
      ) : (
        <UserCircle2 className="h-4 w-4 shrink-0" strokeWidth={1.75} />
      )}
      <span className="flex-1 truncate text-xs">{me?.name ?? 'My profile'}</span>
    </Link>
  );
}

export function AppShell() {
  const navigate = useNavigate();
  const clear = useAuthStore((s) => s.clear);
  const { data: me } = useCurrentUser();
  const { can } = usePermissions();
  const showPalette = useCommandPaletteStore((s) => s.show);
  const [aiOpen, setAiOpen] = useState(false);
  // Sidebar collapse — persisted so it survives reloads.
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem('opshub.sidebar.collapsed') === 'true',
  );
  const toggleSidebar = () =>
    setCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem('opshub.sidebar.collapsed', String(next));
      return next;
    });

  // ── Global ⌘K / Ctrl+K listener ────────────────────────────────────────────
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        showPalette();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [showPalette]);

  async function handleLogout() {
    // POST /v1/bff/logout drops the server-side session AND denylists the access token it
    // held, so the logout is effective at once rather than at token expiry. It is
    // cookie-authenticated and CSRF-gated like any other write, so the token goes with it.
    //
    // What this replaced: reading `authMethod` out of the JWT to decide whether to also
    // call MSAL's logoutRedirect, and a refresh-then-retry dance because a bare fetch
    // without the Authorization header would 401 — leaving the session row alive and the
    // refresh cookie in place, so the next navigation silently signed the user back in.
    // With one opaque cookie there is nothing to inspect and nothing to retry.
    try {
      await fetch(`${ENV.API_BASE_URL}/v1/bff/logout`, {
        method: 'POST',
        credentials: 'include',
        headers: withCsrfHeader('POST'),
      });
    } catch {
      // Best-effort: the cookie is cleared locally either way, below.
    }
    clear();
    setCsrfToken(null);
    resetBootstrap();
    navigate({ to: '/login' });
  }

  return (
    <div className="flex h-full">
      {/* Sidebar */}
      {!collapsed && (
        <aside className="flex w-56 shrink-0 flex-col border-r border-sidebar-border bg-sidebar">
          {/* Logo + collapse toggle */}
          <div className="flex h-14 items-center gap-2.5 px-4 shrink-0">
            <OpsHubMark />
            <span className="text-sm font-semibold tracking-tight text-sidebar-fg-active">
              OpsHub
            </span>
            <Button
              variant="sidebar"
              size="icon-sm"
              className="ml-auto"
              onClick={toggleSidebar}
              title="Hide sidebar"
              aria-label="Hide sidebar"
            >
              <PanelLeftClose className="h-4 w-4" strokeWidth={1.75} />
            </Button>
          </div>

          {/* Divider */}
          <div className="mx-4 h-px bg-sidebar-border" />

          {/* Nav */}
          <nav className="flex flex-1 flex-col gap-5 overflow-y-auto px-2 py-3">
            {navGroups.map((group, gi) => {
              const visibleItems = group.items.filter(({ cap }) => !cap || can(cap));
              if (visibleItems.length === 0) return null;
              return (
                <div key={gi} className="flex flex-col gap-0.5">
                  {group.label && (
                    <span className="px-2 pb-1 text-2xs font-medium uppercase tracking-widest text-sidebar-label">
                      {group.label}
                    </span>
                  )}
                  {visibleItems.map(({ to, label, icon: Icon, upgradeBadge }) => (
                    <Link
                      key={to}
                      to={to}
                      activeOptions={{ exact: to === '/' }}
                      className={cn(
                        'group flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors',
                        'text-sidebar-fg hover:bg-sidebar-hover hover:text-sidebar-fg-active',
                      )}
                      activeProps={{
                        className:
                          'group flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm bg-sidebar-active text-sidebar-fg-active shadow-sm',
                      }}
                    >
                      <Icon className="h-4 w-4 shrink-0" strokeWidth={1.75} />
                      <span className="flex-1">{label}</span>
                      {upgradeBadge ? (
                        <span className="rounded px-1 py-0.5 text-2xs font-semibold uppercase tracking-wide bg-accent-secondary-muted text-accent-secondary-muted-fg">
                          Upgrade
                        </span>
                      ) : (
                        <ChevronRight
                          className="h-3 w-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-40"
                          strokeWidth={2}
                        />
                      )}
                    </Link>
                  ))}
                </div>
              );
            })}
          </nav>

          {/* Bottom: user footer */}
          <div className="mx-4 h-px bg-sidebar-border" />
          <div className="p-2 flex flex-col gap-0.5">
            {/* Profile link */}
            <UserFooter />
            {/* Sign out */}
            <Button variant="sidebar" size="row" className="gap-2.5" onClick={handleLogout}>
              <LogOut className="h-4 w-4 shrink-0" strokeWidth={1.75} />
              Sign out
            </Button>
          </div>
        </aside>
      )}

      {/* Main content */}
      <main className="flex min-w-0 flex-1 flex-col overflow-auto bg-page">
        {/* Top bar */}
        <div className="sticky top-0 z-20 flex h-12 shrink-0 items-center justify-between border-b border-border bg-surface/85 px-6 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-surface/70">
          <div className="flex items-center gap-2">
            {collapsed && (
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={toggleSidebar}
                title="Show sidebar"
                aria-label="Show sidebar"
              >
                <PanelLeft className="h-4 w-4" strokeWidth={1.75} />
              </Button>
            )}
            {/* ⌘K search trigger */}
            <Button
              variant="outline"
              size="sm"
              onClick={() => showPalette()}
              className="h-8 gap-2 border-border bg-surface-muted px-3 text-sm text-fg-subtle hover:border-border-strong hover:bg-surface-muted hover:text-fg-muted"
            >
              <Search className="h-3.5 w-3.5" strokeWidth={1.75} />
              <span className="hidden sm:inline">Search…</span>
              <kbd className="hidden rounded border border-border bg-surface px-1.5 py-0.5 text-2xs text-fg-subtle sm:inline">
                ⌘K
              </kbd>
            </Button>
          </div>

          <div className="flex items-center gap-2">
            <ThemeToggle />
            <NotificationBell />
            {FEATURES.AI_ASSISTANT && (
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={() => setAiOpen(true)}
                title="AI Assistant"
                aria-label="AI Assistant"
              >
                <Sparkles className="h-4 w-4" strokeWidth={1.75} />
              </Button>
            )}
            {/* divider */}
            <div className="h-5 w-px bg-border" />
            <Link
              to="/profile"
              className="flex items-center gap-2 rounded-lg px-2 py-1 text-sm text-fg-muted hover:bg-surface-hover"
            >
              <UserCircle2 className="h-4 w-4 text-fg-subtle" strokeWidth={1.75} />
              <span className="text-xs font-medium text-fg-muted hidden sm:block">
                {me?.name ?? ''}
              </span>
            </Link>
          </div>
        </div>
        <div className="mx-auto w-full max-w-[1600px] px-6 py-7 md:px-8">
          <Outlet />
        </div>
      </main>

      {/* Command palette — rendered outside main so it overlays everything */}
      <CommandPalette />

      {/* AI Assistant panel */}
      {FEATURES.AI_ASSISTANT && <AiChatPanel open={aiOpen} onClose={() => setAiOpen(false)} />}
    </div>
  );
}
