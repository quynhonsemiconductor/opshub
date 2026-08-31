/**
 * CommandPalette — ⌘K / Ctrl+K global command palette.
 *
 * Architecture:
 *  - Static commands (navigation, quick actions) defined locally — always shown.
 *  - Dynamic results from live API search (employees, assets) — debounced, see `useDebounced`.
 *    Static command filtering is NOT debounced: it is local and must feel instant.
 *  - Keyboard navigation: ↑↓ to move, Enter to select, Escape to close.
 *  - Groups: Navigate | Actions | People | Assets
 *
 * Patterns:
 *  - useCommandPaletteStore controls open state from anywhere in the app.
 *  - Global ⌘K listener registered in AppShell (single location).
 *  - No external cmdk library — built on native inputs for bundle size.
 *  - Focus trap + Escape handled internally.
 */
import { useEffect, useRef, useState, useMemo, useCallback, type ReactNode } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import {
  LayoutDashboard,
  Laptop,
  Users,
  ShieldCheck,
  ScanLine,
  CalendarClock,
  Inbox,
  BarChart2,
  Settings,
  Search,
  ArrowRight,
  Hash,
} from 'lucide-react';
import { cn } from '@/shared/lib/utils';
import { api } from '@/shared/api/client';
import { STALE } from '@/shared/api/cache';
import type { EmployeeResponse, AssetResponse } from '@/shared/api/types';
import { useCommandPaletteStore } from './use-command-palette';
import { usePermissions } from '@/shared/hooks/use-permissions';
import { useDebounced } from '@/shared/hooks/use-debounced';
import { OVERLAY_LAYER } from '@/shared/ui/use-escape-to-close';
import { Button } from '@/shared/ui';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Command {
  id: string;
  group: string;
  label: string;
  description?: string;
  icon?: ReactNode;
  /** Route to navigate to, OR an onSelect handler. */
  href?: string;
  onSelect?: () => void;
  /** Keywords for fuzzy matching beyond the label. */
  keywords?: string[];
}

// ── Static navigation commands ────────────────────────────────────────────────

function useNavCommands(can: (cap: string) => boolean): Command[] {
  return useMemo(() => {
    const nav: Array<{
      label: string;
      href: string;
      icon: ReactNode;
      cap?: string;
      kw?: string[];
    }> = [
      {
        label: 'Overview',
        href: '/',
        icon: <LayoutDashboard className="h-4 w-4" strokeWidth={1.75} />,
        kw: ['home', 'dashboard'],
      },
      {
        label: 'People',
        href: '/people',
        icon: <Users className="h-4 w-4" strokeWidth={1.75} />,
        cap: 'employee.read',
      },
      {
        label: 'Assets',
        href: '/assets',
        icon: <Laptop className="h-4 w-4" strokeWidth={1.75} />,
        cap: 'asset.read',
      },
      {
        label: 'Access Requests',
        href: '/access',
        icon: <ShieldCheck className="h-4 w-4" strokeWidth={1.75} />,
        cap: 'access_request.read',
        kw: ['pim', 'admin', 'temp'],
      },
      {
        label: 'Compliance',
        href: '/compliance',
        icon: <ScanLine className="h-4 w-4" strokeWidth={1.75} />,
        cap: 'compliance.read',
        kw: ['security', 'findings', 'software'],
      },
      {
        label: 'Inbox',
        href: '/requests',
        icon: <Inbox className="h-4 w-4" strokeWidth={1.75} />,
        kw: ['approvals', 'queue', 'pending'],
      },
      {
        label: 'Workforce',
        href: '/workforce',
        icon: <CalendarClock className="h-4 w-4" strokeWidth={1.75} />,
        kw: ['leave', 'ot', 'overtime', 'timesheet'],
      },
      {
        label: 'Reports',
        href: '/reports',
        icon: <BarChart2 className="h-4 w-4" strokeWidth={1.75} />,
        cap: 'reports.read',
        kw: ['analytics', 'charts'],
      },
      {
        label: 'Audit Logs',
        href: '/settings/audit-logs',
        icon: <Settings className="h-4 w-4" strokeWidth={1.75} />,
        cap: 'audit.read',
      },
    ];

    return nav
      .filter(({ cap }) => !cap || can(cap))
      .map(({ label, href, icon, kw }) => ({
        id: `nav:${href}`,
        group: 'Navigate',
        label,
        href,
        icon,
        keywords: kw,
      }));
  }, [can]);
}

// ── Fuzzy match (simple, fast) ────────────────────────────────────────────────

function fuzzyMatch(query: string, target: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (t.includes(q)) return true;
  // character-order subsequence match
  let qi = 0;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) qi++;
  }
  return qi === q.length;
}

function matchesQuery(cmd: Command, query: string): boolean {
  return (
    fuzzyMatch(query, cmd.label) ||
    (cmd.description ? fuzzyMatch(query, cmd.description) : false) ||
    (cmd.keywords?.some((k) => fuzzyMatch(query, k)) ?? false)
  );
}

// ── Live search hooks ─────────────────────────────────────────────────────────

function useLivePeopleSearch(query: string, enabled: boolean) {
  return useQuery({
    queryKey: ['cmd-people', query],
    queryFn: async (): Promise<Command[]> => {
      if (!query) return [];
      const { data } = await api.GET('/v1/employees', {
        params: { query: { search: query, limit: 5 } },
      });
      return (data?.data ?? []).map((e: EmployeeResponse) => ({
        id: `person:${e.id}`,
        group: 'People',
        label: e.displayName,
        description: e.jobTitle ?? e.department ?? e.email,
        icon: <Users className="h-4 w-4" strokeWidth={1.75} />,
        href: `/people`,
      }));
    },
    enabled: enabled && query.length >= 2,
    staleTime: STALE.LIVE,
  });
}

function useLiveAssetSearch(query: string, enabled: boolean) {
  return useQuery({
    queryKey: ['cmd-assets', query],
    queryFn: async (): Promise<Command[]> => {
      if (!query) return [];
      const { data } = await api.GET('/v1/assets', {
        params: { query: { search: query, limit: 5 } },
      });
      return (data?.data ?? []).map((a: AssetResponse) => ({
        id: `asset:${a.id}`,
        group: 'Assets',
        label: a.assetTag,
        description: [a.type, a.model].filter(Boolean).join(' · '),
        icon: <Laptop className="h-4 w-4" strokeWidth={1.75} />,
        href: `/assets`,
      }));
    },
    enabled: enabled && query.length >= 2,
    staleTime: STALE.LIVE,
  });
}

// ── Item component ────────────────────────────────────────────────────────────

interface CmdItemProps {
  cmd: Command;
  active: boolean;
  onHover: () => void;
  onSelect: () => void;
}

function CmdItem({ cmd, active, onHover, onSelect }: CmdItemProps) {
  return (
    <li
      role="option"
      aria-selected={active}
      onClick={onSelect}
      onMouseEnter={onHover}
      className={cn(
        'flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 transition-colors',
        active ? 'bg-accent-muted text-accent' : 'text-fg-muted hover:bg-surface-hover',
      )}
    >
      <span className={cn('shrink-0', active ? 'text-accent' : 'text-fg-subtle')}>
        {cmd.icon ?? <Hash className="h-4 w-4" strokeWidth={1.75} />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{cmd.label}</span>
        {cmd.description && (
          <span className="block truncate text-xs text-fg-subtle">{cmd.description}</span>
        )}
      </span>
      {active && <ArrowRight className="h-3.5 w-3.5 shrink-0 text-accent" strokeWidth={2} />}
    </li>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function CommandPalette() {
  const { open, hide, initialQuery } = useCommandPaletteStore();
  const navigate = useNavigate();
  const { can } = usePermissions();

  const [query, setQuery] = useState('');
  const [activeIdx, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // Reset transient UI state and focus the input each time the palette opens.
  // Deferred to a macrotask so the resets are not synchronous within the effect
  // (and so the input exists before we focus it).
  useEffect(() => {
    if (!open) return;
    const id = setTimeout(() => {
      setQuery(initialQuery);
      setActive(0);
      inputRef.current?.focus();
    }, 0);
    return () => clearTimeout(id);
  }, [open, initialQuery]);

  const navCommands = useNavCommands(can);
  /*
   * DEBOUNCED, which the docblock above has always claimed and the code never did.
   *
   * Both searches ran on every keystroke past two characters, so an eleven-character query was twenty
   * requests across `/v1/employees` and `/v1/assets` — two paged database reads each time, for results
   * the user never saw because the next keystroke replaced them. `EntityPicker` debounces the same
   * endpoints; the hook is now shared rather than one surface having it and the other describing it.
   *
   * Static command filtering still uses the RAW query: it is local, costs nothing, and feeling instant
   * is the point of a palette. Only the network work waits.
   */
  const debouncedQuery = useDebounced(query);
  const { data: peopleResults = [] } = useLivePeopleSearch(debouncedQuery, open);
  const { data: assetResults = [] } = useLiveAssetSearch(debouncedQuery, open);

  // Filter static commands against query; merge with live results
  const allCommands = useMemo<Command[]>(() => {
    const filtered = navCommands.filter((c) => matchesQuery(c, query));
    return [...filtered, ...peopleResults, ...assetResults];
  }, [navCommands, query, peopleResults, assetResults]);

  // Group for display
  const grouped = useMemo(() => {
    const map = new Map<string, Command[]>();
    for (const cmd of allCommands) {
      if (!map.has(cmd.group)) map.set(cmd.group, []);
      map.get(cmd.group)!.push(cmd);
    }
    return [...map.entries()];
  }, [allCommands]);

  // Scroll active item into view
  useEffect(() => {
    const item = listRef.current?.querySelector(`[aria-selected="true"]`);
    item?.scrollIntoView({ block: 'nearest' });
  }, [activeIdx]);

  const selectCommand = useCallback(
    (cmd: Command) => {
      hide();
      if (cmd.onSelect) {
        cmd.onSelect();
      } else if (cmd.href) {
        navigate({ to: cmd.href });
      }
    },
    [hide, navigate],
  );

  function handleKeyDown(e: React.KeyboardEvent) {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActive((i) => Math.min(i + 1, allCommands.length - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActive((i) => Math.max(i - 1, 0));
        break;
      case 'Enter':
        e.preventDefault();
        if (allCommands[activeIdx]) selectCommand(allCommands[activeIdx]);
        break;
      case 'Escape':
        e.preventDefault();
        hide();
        break;
    }
  }

  // Track running index across groups for keyboard selection
  let runningIdx = 0;

  if (!open) return null;

  return (
    <>
      {/*
        Backdrop. `dialog` layer, not `drawer`: at `z-50` the palette rendered UNDERNEATH any `Modal`
        (`z-[60]`), so ⌘K over an open dialog dimmed the screen and put the palette behind it. The
        `data-overlay-layer` attribute is what `useEscapeToClose` arbitrates on, so without it Escape
        went to whatever else was open instead of closing the palette.
      */}
      <div
        aria-hidden="true"
        data-overlay-layer={OVERLAY_LAYER.dialog}
        className="fixed inset-0 z-[60] bg-black/40 backdrop-blur-[2px]"
        onClick={hide}
      />

      {/* Palette */}
      <div
        role="combobox"
        data-overlay-layer={OVERLAY_LAYER.dialog}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label="Command palette"
        className={cn(
          'fixed left-1/2 top-[18%] z-[60] w-full max-w-[560px] -translate-x-1/2',
          'overflow-hidden rounded-xl bg-surface shadow-lg ring-1 ring-border',
          // One token, defined in `app/styles/globals.css` — which is also where reduced motion turns it
          // off. It replaces `animate-in fade-in-0 zoom-in-95 duration-150`: tailwindcss-animate's
          // vocabulary, a plugin this repo does not depend on, so those four classes emitted no CSS.
          'animate-dialog-in',
        )}
        onKeyDown={handleKeyDown}
      >
        {/* Search input */}
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <Search className="h-4 w-4 shrink-0 text-fg-subtle" strokeWidth={1.75} />
          <input
            ref={inputRef}
            type="text"
            placeholder="Search pages, people, assets…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            aria-autocomplete="list"
            aria-controls="cmd-results"
            className="flex-1 bg-transparent text-sm text-fg placeholder:text-fg-subtle focus:outline-none"
          />
          {query && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setQuery('')}
              className="h-auto px-1.5 py-0.5 text-fg-subtle hover:bg-transparent hover:text-fg-muted"
            >
              Clear
            </Button>
          )}
          <kbd className="hidden shrink-0 rounded border border-border bg-surface-muted px-1.5 py-0.5 text-2xs text-fg-subtle sm:inline">
            Esc
          </kbd>
        </div>

        {/* Results */}
        <div className="max-h-80 overflow-y-auto p-2">
          {allCommands.length === 0 ? (
            <div className="py-8 text-center text-sm text-fg-subtle">
              No results for <span className="font-medium text-fg-muted">"{query}"</span>
            </div>
          ) : (
            <ul
              ref={listRef}
              id="cmd-results"
              role="listbox"
              aria-label="Commands"
              className="flex flex-col gap-1"
            >
              {grouped.map(([group, cmds]) => (
                <li key={group}>
                  <p className="mb-0.5 px-3 text-2xs font-medium uppercase tracking-wider text-fg-subtle">
                    {group}
                  </p>
                  <ul>
                    {cmds.map((cmd) => {
                      const idx = runningIdx++;
                      return (
                        <CmdItem
                          key={cmd.id}
                          cmd={cmd}
                          active={idx === activeIdx}
                          onHover={() => setActive(idx)}
                          onSelect={() => selectCommand(cmd)}
                        />
                      );
                    })}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Footer hint */}
        <div className="flex items-center justify-between border-t border-border px-4 py-2 text-2xs text-fg-subtle">
          <span>
            <kbd className="rounded border border-border bg-surface-muted px-1 py-0.5">↑↓</kbd>{' '}
            navigate
            {' · '}
            <kbd className="rounded border border-border bg-surface-muted px-1 py-0.5">↵</kbd>{' '}
            select
          </span>
          <span>
            <kbd className="rounded border border-border bg-surface-muted px-1 py-0.5">⌘K</kbd> to
            open
          </span>
        </div>
      </div>
    </>
  );
}
