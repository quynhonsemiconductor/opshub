/**
 * Modal — accessible centered dialog. One primitive for all create/edit forms,
 * replacing per-page hand-rolled `fixed inset-0` overlays.
 *
 *  - ARIA: role=dialog, aria-modal, aria-labelledby
 *  - Focus: first focusable on open, Tab cycles within, restores on close
 *  - Keyboard: Escape closes; click backdrop closes
 *  - Body scroll lock while open
 */
import { useEffect, useRef, useId, type ReactNode, type KeyboardEvent } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/shared/lib/utils';
import { restoreFocus } from './restore-focus';
import { OVERLAY_LAYER, useEscapeToClose } from './use-escape-to-close';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  /** Sticky footer area, e.g. Cancel / Save buttons. */
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  /**
   * The `id` of the control to focus on open, instead of the first focusable one.
   *
   * WHY THIS IS THE MODAL'S JOB. A form opened FROM a specific finding should land on the field that
   * closes it — the supplier register's "No DPA" badge opens the correction form on the agreement
   * picker. A child cannot do that itself: this component owns focus-on-open and its effect is an
   * ancestor's, so it runs AFTER any child effect or `autoFocus` and would overwrite it. Fighting that
   * from the outside means a `setTimeout`; extending the thing that already owns focus does not.
   *
   * Silently ignored when nothing matches, so a renamed field degrades to the default rather than
   * leaving the dialog with focus on the body.
   */
  initialFocus?: string;
}

const SIZE: Record<NonNullable<ModalProps['size']>, string> = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-lg',
};

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),' +
  'textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
  initialFocus,
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();

  useEscapeToClose(open, panelRef, onClose);

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    // The requested field if it is there, else the first focusable — see `initialFocus`. Not
    // `querySelector(`#${id}`)`: an id is not a guaranteed-valid selector, and a bad one throws.
    const requested = initialFocus
      ? (panel?.querySelector<HTMLElement>(`[id="${CSS.escape(initialFocus)}"]`) ?? null)
      : null;
    (requested ?? panel?.querySelectorAll<HTMLElement>(FOCUSABLE)[0])?.focus();
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = '';
      // Not `previouslyFocused.focus()`: the control that opened this modal is often gone, because the
      // action it performed removed it. See `restoreFocus`.
      restoreFocus(previouslyFocused, panel);
    };
  }, [open, initialFocus]);

  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    // Escape is handled by `useEscapeToClose` on the document, because focus is not reliably inside this
    // panel by the time somebody presses it.
    if (e.key !== 'Tab') return;
    const panel = panelRef.current;
    if (!panel) return;
    const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  if (!open) return null;

  return (
    <div
      /*
       * ABOVE THE SLIDE-OVER, not beside it. Both used `z-50`, so stacking fell to DOM order — and a page
       * renders its modals before its drawer, which put every modal opened FROM a drawer behind the drawer
       * panel. The bottom-right of the dialog is where the submit button lives, so it was the part covered:
       * clickable in the middle, dead where it mattered. Measured in the browser, where a renewal submit
       * never became "stable" because the overlay above it never stopped moving.
       */
      className="fixed inset-0 z-[60] flex items-center justify-center p-4"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-[var(--overlay)] backdrop-blur-[2px]"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        // Which overlay owns Escape, mirroring the `z-[60]` above. Kept next to the class it mirrors so
        // the two cannot drift into disagreeing about what is on top.
        data-overlay-layer={OVERLAY_LAYER.dialog}
        onKeyDown={handleKeyDown}
        className={cn(
          'relative z-10 w-full overflow-hidden rounded-xl bg-surface shadow-2xl ring-1 ring-border',
          'animate-in fade-in-0 zoom-in-95 duration-150',
          SIZE[size],
        )}
      >
        <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="truncate text-sm font-semibold text-fg">
              {title}
            </h2>
            {description && (
              <p id={descId} className="mt-0.5 text-xs text-fg-muted">
                {description}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close dialog"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-surface-hover hover:text-fg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            <X className="h-4 w-4" strokeWidth={2} />
          </button>
        </div>

        <div className="max-h-[70vh] overflow-y-auto">{children}</div>

        {footer && (
          <div className="border-t border-border bg-surface-muted px-5 py-3">{footer}</div>
        )}
      </div>
    </div>
  );
}
