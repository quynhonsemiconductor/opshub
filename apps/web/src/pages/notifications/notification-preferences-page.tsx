/**
 * NotificationPreferencesPage
 *
 * Allows the authenticated user to configure per-event-type notification
 * delivery channels (in-app and email).
 *
 * API:
 *   GET    /v1/notifications/preferences            → list explicit overrides
 *   PUT    /v1/notifications/preferences/:type      → upsert a preference
 *   DELETE /v1/notifications/preferences/:type      → reset to default
 *
 * Design decisions:
 *   - Preferences are shown as a grouped table with toggle switches.
 *   - Unset (default) rows show both channels as ON; a visual indicator
 *     differentiates "explicitly enabled" from "default enabled".
 *   - A global wildcard (*) row at the top acts as a master kill-switch.
 *   - Optimistic UI: toggle is updated immediately, rolled back on error.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Bell, Mail, RotateCcw, BellOff } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/shared/api/client';
import { apiErrorMessage } from '@/shared/api/errors';
import type { components } from '@/shared/api/generated/api';
import { IconAction } from '@/shared/ui';

type PreferenceDto = components['schemas']['PreferenceResponseDto'];

/* ── Event catalogue ──────────────────────────────────────────────────────────
 *
 * EXACTLY THE EVENTS THAT CAN BE SENT, which is `NOTIFICATION_TEMPLATE_NAMES` in
 * `libs/platform/src/notifications/notification.templates.ts` — a notification needs a template to be
 * rendered, so that list is the whole of what the system can deliver.
 *
 * This list used to be written by hand and had drifted a long way from it. Thirteen of its nineteen
 * toggles named an event with no template — `workforce.leave_requested`, `asset.retired`,
 * `compliance.finding_resolved` and ten more — so they could never fire whatever the user chose, and
 * the API happily stored a preference row for each, which is what made the screen convincing. Nine
 * events that DO fire had no toggle at all, among them `contract.expiring_soon`, `review.due` and
 * `request.step_ready`: the notifications people actually receive were the ones they could not turn
 * off.
 *
 * `test/notification-preference-contract.spec.ts` now fails if this list and that one disagree in
 * EITHER direction. A new notification has to appear here to ship, which is the point — the settings
 * screen is part of adding a notification, not something to remember afterwards.
 *
 * The labels and the grouping stay here rather than in the backend catalogue: how a notification is
 * described to a person, and which heading it sits under, are editorial choices about this screen.
 */

interface EventEntry {
  type: string;
  label: string;
  /** What actually triggers it, when the label alone would leave a reader guessing. */
  hint?: string;
}

interface EventGroup {
  group: string;
  events: EventEntry[];
}

const EVENT_GROUPS: EventGroup[] = [
  {
    group: 'Approvals',
    events: [
      {
        type: 'request.submitted',
        label: 'A request needs your decision',
        hint: 'Sent to the first approver when a request enters the queue.',
      },
      {
        type: 'request.step_ready',
        label: 'A request has reached your step',
        hint: 'Multi-step approvals only — an earlier approver has signed off and it is now with you.',
      },
      { type: 'request.approved', label: 'Your request was approved' },
      { type: 'request.rejected', label: 'Your request was rejected' },
      {
        type: 'request.sla_breach',
        label: 'A request has breached its SLA',
        hint: 'Sent when a decision is overdue against the target the request type sets.',
      },
      {
        type: 'request.delegation_created',
        label: 'Someone delegated their approvals to you',
        hint: 'You can decide on their behalf until the delegation expires.',
      },
    ],
  },
  {
    group: 'Access',
    events: [
      { type: 'access_request.submitted', label: 'An access request needs review' },
      { type: 'access_request.approved', label: 'Your access request was approved' },
      { type: 'access_request.denied', label: 'Your access request was denied' },
    ],
  },
  {
    group: 'Assets',
    events: [
      { type: 'asset.assigned', label: 'An asset was assigned to you' },
      { type: 'asset.unassigned', label: 'An asset was taken back' },
    ],
  },
  {
    group: 'Contracts and reviews',
    events: [
      {
        type: 'contract.expiring_soon',
        label: 'A contract is expiring soon',
        hint: 'Sent ahead of the renewal date so there is time to act on it.',
      },
      { type: 'contract.expired', label: 'A contract has expired' },
      {
        type: 'review.due',
        label: 'A periodic review is due',
        hint: 'Risk and supplier reviews reaching their review date.',
      },
    ],
  },
  {
    group: 'People',
    events: [
      {
        type: 'employee.offboarded',
        label: 'An employee was offboarded',
        hint: 'Sent to the people who hold their handover tasks.',
      },
    ],
  },
];

// ── Toggle switch ─────────────────────────────────────────────────────────────

interface ToggleProps {
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
  label?: string;
}

function Toggle({ checked, disabled = false, onChange, label }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
      className={[
        'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1',
        disabled ? 'cursor-not-allowed opacity-40' : '',
        checked ? 'bg-accent' : 'bg-surface-hover',
      ].join(' ')}
    >
      <span
        className={[
          'pointer-events-none block h-4 w-4 rounded-full bg-surface shadow-sm transition-transform',
          checked ? 'translate-x-4' : 'translate-x-0',
        ].join(' ')}
      />
    </button>
  );
}

// ── Hooks ─────────────────────────────────────────────────────────────────────

function usePreferences() {
  return useQuery<PreferenceDto[]>({
    queryKey: ['notification-preferences'],
    queryFn: async () => {
      const { data, error } = await api.GET('/v1/notifications/preferences');
      if (error || !data) throw new Error('Failed to load preferences');
      return data as PreferenceDto[];
    },
  });
}

// ── Preference row logic ──────────────────────────────────────────────────────

/**
 * Merge explicit prefs with the "all-on" default.
 * Returns {inApp, email, isDefault} for any event type.
 */
function resolve(
  type: string,
  explicitPrefs: PreferenceDto[],
  wildcard: PreferenceDto | undefined,
): { inApp: boolean; email: boolean; isDefault: boolean } {
  const exact = explicitPrefs.find((p) => p.type === type);
  if (exact) return { inApp: exact.inApp, email: exact.email, isDefault: false };
  // Apply wildcard override if present
  if (wildcard) return { inApp: wildcard.inApp, email: wildcard.email, isDefault: false };
  return { inApp: true, email: true, isDefault: true };
}

// ── Page ──────────────────────────────────────────────────────────────────────

export function NotificationPreferencesPage() {
  const qc = useQueryClient();
  const { data: prefs, isLoading } = usePreferences();
  const [pending, setPending] = useState<Set<string>>(new Set());

  const explicit = prefs ?? [];
  const wildcard = explicit.find((p) => p.type === '*');

  const invalidate = () => qc.invalidateQueries({ queryKey: ['notification-preferences'] });

  async function handleToggle(type: string, channel: 'inApp' | 'email', newValue: boolean) {
    if (pending.has(`${type}-${channel}`)) return;

    // Resolve current values
    const current = resolve(type, explicit, wildcard);
    const nextInApp = channel === 'inApp' ? newValue : current.inApp;
    const nextEmail = channel === 'email' ? newValue : current.email;

    setPending((s) => new Set(s).add(`${type}-${channel}`));

    // Optimistically update query cache
    qc.setQueryData<PreferenceDto[]>(['notification-preferences'], (old = []) => {
      const filtered = old.filter((p) => p.type !== type);
      return [
        ...filtered,
        { type, inApp: nextInApp, email: nextEmail, updatedAt: new Date().toISOString() },
      ];
    });

    const { error } = await api.PUT('/v1/notifications/preferences/{type}', {
      params: { path: { type } },
      body: { inApp: nextInApp, email: nextEmail },
    });

    setPending((s) => {
      const next = new Set(s);
      next.delete(`${type}-${channel}`);
      return next;
    });

    if (error) {
      toast.error(apiErrorMessage(error, 'Failed to save preference.'));
      invalidate(); // rollback
    }
  }

  async function handleReset(type: string) {
    const { error } = await api.DELETE('/v1/notifications/preferences/{type}', {
      params: { path: { type } },
    });
    if (error) {
      toast.error(apiErrorMessage(error, 'Failed to reset preference.'));
      return;
    }
    toast.success('Reset to default');
    invalidate();
  }

  async function handleWildcard(channel: 'inApp' | 'email', newValue: boolean) {
    const currentWildcard = wildcard ?? { inApp: true, email: true };
    const nextInApp = channel === 'inApp' ? newValue : currentWildcard.inApp;
    const nextEmail = channel === 'email' ? newValue : currentWildcard.email;

    // Optimistically
    qc.setQueryData<PreferenceDto[]>(['notification-preferences'], (old = []) => {
      const filtered = old.filter((p) => p.type !== '*');
      return [
        ...filtered,
        { type: '*', inApp: nextInApp, email: nextEmail, updatedAt: new Date().toISOString() },
      ];
    });

    const { error } = await api.PUT('/v1/notifications/preferences/{type}', {
      params: { path: { type: '*' } },
      body: { inApp: nextInApp, email: nextEmail },
    });

    if (error) {
      toast.error(apiErrorMessage(error, 'Failed to update global preference.'));
      invalidate();
    }
  }

  async function resetWildcard() {
    const { error } = await api.DELETE('/v1/notifications/preferences/{type}', {
      params: { path: { type: '*' } },
    });
    if (error) {
      toast.error(apiErrorMessage(error, 'Failed to reset.'));
      return;
    }
    invalidate();
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      {/* Header */}
      <div>
        <h1 className="text-lg font-semibold tracking-tight text-fg">Notification Preferences</h1>
        <p className="mt-0.5 text-sm text-fg-muted">
          Choose how you receive notifications for each event type. Defaults are both in-app and
          email enabled.
        </p>
      </div>

      {isLoading && (
        <div className="rounded-xl border border-border bg-surface px-5 py-10 text-center text-sm text-fg-subtle">
          Loading…
        </div>
      )}

      {!isLoading && (
        <>
          {/* Global override */}
          <div className="rounded-xl border border-blue-100 bg-accent-muted/60 p-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2">
                  {wildcard && (!wildcard.inApp || !wildcard.email) ? (
                    <BellOff className="h-4 w-4 text-warning" strokeWidth={1.75} />
                  ) : (
                    <Bell className="h-4 w-4 text-accent" strokeWidth={1.75} />
                  )}
                  <p className="text-sm font-semibold text-fg">Global override</p>
                </div>
                <p className="mt-0.5 text-xs text-fg-muted">
                  Disabling a channel here overrides all per-event settings below. Use this as a
                  master mute switch.
                </p>
              </div>
              <div className="flex items-center gap-6 shrink-0 pt-0.5">
                <div className="flex flex-col items-center gap-1">
                  <Bell className="h-3.5 w-3.5 text-fg-muted" strokeWidth={1.75} />
                  <span className="text-2xs text-fg-subtle">In-app</span>
                  <Toggle
                    checked={wildcard?.inApp ?? true}
                    onChange={(v) => handleWildcard('inApp', v)}
                    label="Global in-app toggle"
                  />
                </div>
                <div className="flex flex-col items-center gap-1">
                  <Mail className="h-3.5 w-3.5 text-fg-muted" strokeWidth={1.75} />
                  <span className="text-2xs text-fg-subtle">Email</span>
                  <Toggle
                    checked={wildcard?.email ?? true}
                    onChange={(v) => handleWildcard('email', v)}
                    label="Global email toggle"
                  />
                </div>
                {wildcard && (
                  <IconAction
                    label="Reset global override"
                    icon={RotateCcw}
                    onClick={resetWildcard}
                  />
                )}
              </div>
            </div>
          </div>

          {/* Per-event groups */}
          {EVENT_GROUPS.map((grp) => (
            <div
              key={grp.group}
              className="rounded-xl border border-border bg-surface overflow-hidden"
            >
              {/* Group header */}
              <div className="grid grid-cols-[1fr_80px_80px_36px] items-center gap-2 border-b border-border bg-surface-muted px-5 py-2.5">
                <p className="text-xs font-semibold uppercase tracking-wider text-fg-muted">
                  {grp.group}
                </p>
                <div className="flex items-center justify-center gap-1">
                  <Bell className="h-3.5 w-3.5 text-fg-subtle" strokeWidth={1.75} />
                  <span className="text-2xs text-fg-subtle">In-app</span>
                </div>
                <div className="flex items-center justify-center gap-1">
                  <Mail className="h-3.5 w-3.5 text-fg-subtle" strokeWidth={1.75} />
                  <span className="text-2xs text-fg-subtle">Email</span>
                </div>
                <div />
              </div>

              {/* Rows */}
              <div className="divide-y divide-border">
                {grp.events.map(({ type, label, hint }) => {
                  const resolved = resolve(type, explicit, wildcard);
                  // Global wildcard disables the per-row toggles
                  const blockedByWildcard = !!wildcard && (!wildcard.inApp || !wildcard.email);
                  const inAppDisabled = !!wildcard && !wildcard.inApp;
                  const emailDisabled = !!wildcard && !wildcard.email;

                  return (
                    <div
                      key={type}
                      className={`grid grid-cols-[1fr_80px_80px_36px] items-center gap-2 px-5 py-3 ${blockedByWildcard ? 'opacity-60' : ''}`}
                    >
                      {/*
                       * THE HINT, NOT THE EVENT KEY. This line was `request.step_ready` in a mono
                       * font — the internal name, on a screen whose whole job is to let somebody
                       * decide whether they want the thing. It said nothing about what arrives or
                       * when, which is the only question being asked here. Shown only where the
                       * label leaves a real gap; a hint under every row is noise that trains people
                       * to stop reading them.
                       */}
                      <div>
                        <p className="text-sm text-fg">{label}</p>
                        {hint && <p className="mt-0.5 text-xs text-fg-subtle">{hint}</p>}
                      </div>
                      <div className="flex justify-center">
                        <Toggle
                          checked={resolved.inApp}
                          disabled={inAppDisabled || pending.has(`${type}-inApp`)}
                          onChange={(v) => handleToggle(type, 'inApp', v)}
                          label={`${label} in-app toggle`}
                        />
                      </div>
                      <div className="flex justify-center">
                        <Toggle
                          checked={resolved.email}
                          disabled={emailDisabled || pending.has(`${type}-email`)}
                          onChange={(v) => handleToggle(type, 'email', v)}
                          label={`${label} email toggle`}
                        />
                      </div>
                      <div className="flex justify-center">
                        {!resolved.isDefault && (
                          <IconAction
                            label={`Reset ${label} to default`}
                            icon={RotateCcw}
                            onClick={() => handleReset(type)}
                          />
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
