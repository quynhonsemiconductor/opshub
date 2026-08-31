/**
 * NotificationBell — header bell icon with unread badge + popover panel.
 *
 * Architecture:
 *  1. useSSENotifications() maintains a live SSE connection for real-time updates.
 *  2. On bell click: fetch the notification list, show popover.
 *  3. Clicking a notification marks it read (optimistic update + API call).
 *  4. "Mark all read" button clears the badge instantly.
 *
 * The popover is a simple absolute-positioned panel — no extra library.
 * Click-outside detection via a useEffect listener on document.
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import { ENV } from '@/shared/config/env';
import { Bell, Check, CheckCheck, X, Inbox } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/shared/api/client';
import { Button } from '@/shared/ui';
import { STALE } from '@/shared/api/cache';
import { sessionFetch } from '@/shared/api/session-fetch';
import type { InAppNotification, NotificationListResult } from '@/shared/api/types';
import { useSSENotifications } from './use-sse-notifications';

// ── Helpers ──────────────────────────────────────────────────────────────────

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

const TYPE_ICON: Record<string, string> = {
  'access_request.submitted': '🔐',
  'access_request.approved': '✅',
  'access_request.denied': '❌',
  'request.submitted': '📋',
  'request.approved': '✅',
  'request.rejected': '❌',
  'request.step_ready': '👆',
  'request.sla_breach': '⚠️',
  'request.delegation_created': '🤝',
  'asset.assigned': '💻',
  'employee.offboarded': '🚪',
};

// ── Fetch hook ────────────────────────────────────────────────────────────────

function useNotificationList(enabled: boolean) {
  return useQuery<NotificationListResult>({
    queryKey: ['notifications', 'list'],
    queryFn: async () => {
      const res = await sessionFetch(`${ENV.API_BASE_URL}/v1/notifications?limit=20`);
      if (!res.ok) throw new Error('Failed to load notifications');
      return res.json() as Promise<NotificationListResult>;
    },
    enabled,
    staleTime: STALE.WATCHED,
  });
}

// ── Notification item ─────────────────────────────────────────────────────────

interface NotifItemProps {
  notif: InAppNotification;
  onMarkRead: (id: string) => void;
}

function NotifItem({ notif, onMarkRead }: NotifItemProps) {
  const icon = TYPE_ICON[notif.type] ?? '🔔';
  return (
    <div
      className={[
        'flex gap-3 px-4 py-3 transition-colors hover:bg-surface-hover cursor-pointer',
        notif.isRead ? 'opacity-60' : '',
      ].join(' ')}
      onClick={() => !notif.isRead && onMarkRead(notif.id)}
    >
      <span className="mt-0.5 shrink-0 text-base leading-none">{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-fg">{notif.title}</p>
        {notif.body && <p className="mt-0.5 text-xs text-fg-muted line-clamp-2">{notif.body}</p>}
        <p className="mt-1 text-2xs text-fg-subtle">{relativeTime(notif.createdAt)}</p>
      </div>
      {!notif.isRead && <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-accent-muted0" />}
    </div>
  );
}

// ── Bell component ─────────────────────────────────────────────────────────────

export function NotificationBell() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const { unreadCount, resetUnread, decrementUnread } = useSSENotifications();

  // Re-fetch list whenever panel opens
  const { data, isLoading, isError } = useNotificationList(open);

  // Invalidate list when SSE delivers a new notification
  useEffect(() => {
    if (unreadCount > 0 && open) {
      qc.invalidateQueries({ queryKey: ['notifications', 'list'] });
    }
  }, [unreadCount, open, qc]);

  // Click-outside closes panel
  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (
        panelRef.current &&
        !panelRef.current.contains(e.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const markRead = useCallback(
    async (id: string) => {
      // Optimistic update in list cache
      qc.setQueryData<NotificationListResult>(['notifications', 'list'], (old) =>
        old
          ? { ...old, items: old.items.map((n) => (n.id === id ? { ...n, isRead: true } : n)) }
          : old,
      );
      decrementUnread();
      await api.PATCH('/v1/notifications/{id}/read', { params: { path: { id } } });
    },
    [qc, decrementUnread],
  );

  const markAllRead = useCallback(async () => {
    qc.setQueryData<NotificationListResult>(['notifications', 'list'], (old) =>
      old ? { ...old, items: old.items.map((n) => ({ ...n, isRead: true })) } : old,
    );
    resetUnread();
    await api.PATCH('/v1/notifications/read-all');
  }, [qc, resetUnread]);

  return (
    <div className="relative">
      <Button
        ref={buttonRef}
        variant="ghost"
        size="icon"
        className="relative h-8 w-8 text-fg-subtle"
        onClick={() => setOpen((o) => !o)}
        aria-label="Notifications"
      >
        <Bell className="h-4 w-4" strokeWidth={1.75} />
        {unreadCount > 0 && (
          <span className="absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded-full bg-accent-muted0 text-2xs font-semibold leading-none text-white">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </Button>

      {open && (
        <div
          ref={panelRef}
          className="absolute right-0 top-10 z-50 w-80 overflow-hidden rounded-xl border border-border bg-surface shadow-lg"
        >
          {/* Header */}
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <span className="text-sm font-semibold text-fg">Notifications</span>
            <div className="flex items-center gap-1">
              {unreadCount > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-auto gap-1 px-2 py-1 hover:text-fg-muted"
                  onClick={markAllRead}
                  title="Mark all as read"
                >
                  <CheckCheck className="h-3.5 w-3.5" />
                  Mark all read
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon-sm"
                className="h-auto w-auto p-1 text-fg-subtle"
                onClick={() => setOpen(false)}
                aria-label="Close notifications"
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>

          {/* List */}
          <div className="max-h-80 overflow-y-auto divide-y divide-border">
            {isLoading && (
              <div className="flex items-center justify-center py-8">
                <span className="text-sm text-fg-subtle">Loading…</span>
              </div>
            )}
            {/*
              A FAILED FETCH IS NOT AN EMPTY INBOX. This branch fired on `!data?.items.length`, which
              an error also produces — so a dropped request told the reader they had nothing waiting.
              Of all the places to invent silence, the notification bell is the worst: the whole point
              of it is to be the thing you trust instead of checking every screen.
            */}
            {!isLoading && isError && (
              <div
                role="alert"
                className="flex flex-col items-center justify-center gap-2 py-10 text-center"
              >
                <Inbox className="h-8 w-8 text-fg-subtle" strokeWidth={1.5} />
                <p className="text-sm text-fg-muted">Couldn&apos;t load your notifications</p>
                <p className="text-2xs text-fg-subtle">This is not an empty inbox — try again.</p>
              </div>
            )}
            {!isLoading && !isError && !data?.items.length && (
              <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
                <Inbox className="h-8 w-8 text-fg-subtle" strokeWidth={1.5} />
                <p className="text-sm text-fg-subtle">No notifications yet</p>
              </div>
            )}
            {data?.items.map((n) => (
              <NotifItem key={n.id} notif={n} onMarkRead={markRead} />
            ))}
          </div>

          {/* Footer */}
          {(data?.items.length ?? 0) > 0 && (
            <div className="border-t border-border px-4 py-2.5">
              <Button
                variant="ghost"
                size="row"
                className="justify-center gap-1.5 text-xs hover:bg-transparent hover:text-fg-muted"
                onClick={markAllRead}
              >
                <Check className="h-3.5 w-3.5" />
                Mark all as read
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
