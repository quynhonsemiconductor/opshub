/**
 * ConfirmDialog — typed, accessible confirmation modal.
 *
 * Usage:
 *   <ConfirmDialog
 *     open={showConfirm}
 *     variant="danger"
 *     title="Retire asset?"
 *     description="This cannot be undone."
 *     confirmLabel="Retire"
 *     onConfirm={handleRetire}
 *     onCancel={() => setShowConfirm(false)}
 *     loading={retiring}
 *   />
 */
import { useEffect, useRef, useId, type ReactNode } from 'react';
import { AlertTriangle, Info } from 'lucide-react';
import { cn } from '@/shared/lib/utils';
import { OVERLAY_LAYER } from './use-escape-to-close';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ConfirmDialogProps {
  open: boolean;
  variant?: 'danger' | 'warning' | 'default';
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

// ── Config ────────────────────────────────────────────────────────────────────

const ICON = {
  danger: <AlertTriangle className="h-5 w-5 text-danger" strokeWidth={1.75} />,
  warning: <AlertTriangle className="h-5 w-5 text-warning" strokeWidth={1.75} />,
  default: <Info className="h-5 w-5 text-accent" strokeWidth={1.75} />,
} as const;

const CONFIRM_BTN: Record<NonNullable<ConfirmDialogProps['variant']>, string> = {
  danger:
    'bg-red-600 text-white hover:bg-red-700 dark:hover:bg-red-500 focus-visible:ring-red-500/40',
  warning:
    'bg-amber-600 text-white hover:bg-amber-700 dark:hover:bg-amber-500 focus-visible:ring-amber-500/40',
  default: 'bg-accent text-accent-fg hover:bg-accent-hover focus-visible:ring-accent/40',
};

// ── Component ─────────────────────────────────────────────────────────────────

export function ConfirmDialog({
  open,
  variant = 'default',
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  loading = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const titleId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);

  // Focus cancel button on open (safe default for destructive actions)
  useEffect(() => {
    if (open) {
      cancelRef.current?.focus();
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [open]);

  if (!open) return null;

  return (
    <>
      {/*
       * ABOVE THE SLIDE-OVER, at the same layer as `Modal` and for the same reason. Both this and the
       * drawer panel used `z-50`, so stacking fell to DOM order — and a page renders its dialogs before its
       * drawer, which put every confirmation opened FROM a drawer UNDER the drawer panel.
       *
       * WHAT THAT ACTUALLY BROKE, measured rather than assumed: the drawer stayed lit and fully
       * interactive behind an open confirmation, so the modal backdrop guarded nothing and the drawer's own
       * buttons could still be clicked while a decision was pending. Whether the drawer also covered part
       * of the dialog was down to the viewport — this dialog is centred and the drawer is on the right, so
       * a narrow window hid the confirm button and a wide one did not. A stacking bug that depends on the
       * window size is the kind that reaches production.
       */}
      <div
        aria-hidden="true"
        className="fixed inset-0 z-[60] bg-[var(--overlay)] backdrop-blur-[2px]"
        onClick={onCancel}
      />

      {/* Dialog */}
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        // Above any drawer this was opened from, so Escape closes the confirmation ALONE. Without it the
        // drawer's own document-level handler fired too, and one keypress took both.
        data-overlay-layer={OVERLAY_LAYER.dialog}
        className={cn(
          'fixed left-1/2 top-1/2 z-[60] w-full max-w-sm -translate-x-1/2 -translate-y-1/2',
          'rounded-xl bg-surface shadow-lg ring-1 ring-border',
          // One token, defined in `app/styles/globals.css` — which is also where reduced motion turns it
          // off. It replaces `animate-in fade-in-0 zoom-in-95 duration-150`: tailwindcss-animate's
          // vocabulary, a plugin this repo does not depend on, so those four classes emitted no CSS.
          'animate-dialog-in',
        )}
        onKeyDown={(e) => e.key === 'Escape' && onCancel()}
      >
        <div className="p-5">
          {/* Icon + title */}
          <div className="flex items-start gap-3">
            <div className="mt-0.5 shrink-0">{ICON[variant]}</div>
            <div className="flex-1 min-w-0">
              <h3 id={titleId} className="text-sm font-semibold text-fg">
                {title}
              </h3>
              {description && <p className="mt-1 text-sm text-fg-muted">{description}</p>}
            </div>
          </div>

          {/* Actions */}
          <div className="mt-5 flex justify-end gap-2">
            <button
              ref={cancelRef}
              type="button"
              onClick={onCancel}
              disabled={loading}
              className="h-8 rounded-md border border-border bg-surface px-4 text-sm font-medium text-fg-muted transition-colors hover:bg-surface-hover disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              {cancelLabel}
            </button>
            <button
              type="button"
              onClick={onConfirm}
              disabled={loading}
              className={cn(
                'h-8 rounded-md px-4 text-sm font-medium transition-colors disabled:opacity-50',
                'focus-visible:outline-none focus-visible:ring-2',
                CONFIRM_BTN[variant],
              )}
            >
              {loading ? 'Loading…' : confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
