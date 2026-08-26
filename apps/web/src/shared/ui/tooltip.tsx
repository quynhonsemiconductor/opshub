import {
  cloneElement,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { cn } from '@/shared/lib/utils';

/**
 * Tooltip — the supporting sentence for a control whose label cannot carry it.
 *
 * WHY THIS IS IN THE KIT AND NOT WRITTEN PER PAGE. The kit had no tooltip at all, so the 26 places
 * that wanted one reached for the only thing available: `title="…"`. That attribute is not a tooltip.
 * It never appears on a touch device, it cannot be styled, it waits about a second before showing, and
 * a screen reader's treatment of it varies by reader and by setting — so the one audience most in need
 * of the extra sentence is the audience least likely to get it.
 *
 * Nearly all 26 are worse than useless, because they restate the verb already in the `aria-label` next
 * to them — `aria-label={`Retire ${control.title}`} title="Retire"`, in eleven files, and `title={label}`
 * inside `IconAction`, which is every icon action in the product. A slow, unstyleable duplicate of the
 * accessible NAME, where the thing worth saying was a description.
 *
 * A hover-only `<div>` is the other thing people write when this is missing, and it is the reason the
 * accessibility wiring lives here rather than at each call site:
 *
 *  - IT OPENS ON FOCUS, not only on `mouseenter`. A tooltip a keyboard user cannot reach is a tooltip
 *    for people who already had the mouse.
 *  - IT IS WIRED WITH `aria-describedby`, so the sentence is announced when focus lands on the trigger.
 *    Unannounced additional content is decoration. `aria-describedby` and NOT `aria-labelledby`: this
 *    is supplementary description, and a control whose only accessible name comes from a tooltip has no
 *    name whenever the tooltip is closed. The trigger must already be named — `IconAction`'s required
 *    `label`, a `Badge`'s own text — and this adds to that, never replaces it.
 *  - ESCAPE DISMISSES IT while it is showing, and the pointer can move ONTO it without it vanishing.
 *    Those are the Dismissible and Hoverable halves of WCAG 1.4.13 (Content on Hover or Focus), and
 *    both are structural rather than cosmetic — see the two comments in the render below.
 *
 * NOT PORTALLED, DELIBERATELY, and this is the stacking rule. A tooltip opened inside a `Modal`
 * (`z-[60]`) or a `SlideOver` (`z-50`) renders inside that panel's own stacking context, so it is above
 * the overlay because it is INSIDE it — there is no number to keep in agreement with anything. Portal
 * it to `document.body` and the tooltip needs its own rung above every value in `OVERLAY_LAYER`, which
 * is a second copy of that ladder in a file that has no reason to know about drawers; the first thing
 * to land above `z-[60]` would paint over it. `z-30` is the local rung: above `EntityPicker`'s `z-20`
 * listbox, and below `OVERLAY_LAYER.drawer` so a tooltip left open on the page cannot sit over a drawer
 * that opens on top of it.
 *
 * THE COST OF NOT PORTALLING is clipping: an ancestor with `overflow-hidden` (a `Modal` panel) or
 * `overflow-x-auto` (a `DataTable`) cuts the bubble at its edge. `placement="bottom"` is the escape
 * hatch for a trigger near a container's top edge. If a tooltip needs to escape a scroll box to be
 * legible at all, that is usually the content telling you it wanted to be a column or a hint.
 */

/**
 * The pointer must rest this long before the bubble appears — and NOTHING waits on focus.
 *
 * The asymmetry is the point. A pointer crossing a table row passes over several triggers on its way
 * somewhere else, and a tooltip firing under each is flicker rather than help, so hover has to prove
 * intent. Focus already is intent: it was arrived at by a deliberate keypress.
 *
 * There is a second, harder reason focus cannot be delayed. `aria-describedby` points at the bubble
 * only while the bubble EXISTS — a dangling reference is silently dropped by assistive tech, so the
 * description has to be in the accessibility tree at the moment focus lands or the reader announces
 * the control without it and never comes back. A delay on focus would not make the announcement late;
 * it would remove it.
 */
const HOVER_DELAY_MS = 400;

export interface TooltipProps {
  /** The sentence. A phrase or one short sentence — anything longer is a hint under the field. */
  content: ReactNode;
  /**
   * The trigger: ONE already-focusable, already-named element.
   *
   * Focusable, because the tooltip opens on focus and a `<span>` is never focused. Named, because
   * `aria-describedby` supplements a name and cannot supply one. Cloned only to add that attribute —
   * the events are bound on the wrapper, where `focusin` and `mouseover` already bubble up from the
   * trigger, so a caller's own `onFocus` or `onMouseEnter` is never overwritten.
   */
  children: ReactElement<{ 'aria-describedby'?: string }>;
  /** `bottom` when the trigger sits near the top edge of a clipping container. */
  placement?: 'top' | 'bottom';
}

export function Tooltip({ content, children, placement = 'top' }: TooltipProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A pointer that leaves before the delay elapses must not open anything a moment later, and a
  // trigger removed by the action it performs must not fire into an unmounted component.
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  /*
   * ESCAPE, IN THE CAPTURE PHASE, AND IT STOPS THERE.
   *
   * `useEscapeToClose` listens on the document in the BUBBLE phase, so a tooltip open inside a modal
   * would otherwise answer one keypress twice: the bubble dismisses the tooltip and closes the dialog
   * under it. Capture on the document runs before any bubble listener on the document and before React's
   * own delegated handlers, so `stopPropagation` here means the overlay never sees the key — which is
   * correct, since the innermost thing on screen is the one Escape belongs to. Same rule the overlay
   * layers encode, one rung further in.
   */
  useEffect(() => {
    if (!open) return;
    function dismiss(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setOpen(false);
    }
    document.addEventListener('keydown', dismiss, true);
    return () => document.removeEventListener('keydown', dismiss, true);
  }, [open]);

  function cancelPending() {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }

  function openNow() {
    cancelPending();
    setOpen(true);
  }

  function openAfterDelay() {
    cancelPending();
    timer.current = setTimeout(() => setOpen(true), HOVER_DELAY_MS);
  }

  function close() {
    cancelPending();
    setOpen(false);
  }

  // Existing `aria-describedby` is kept and appended to, not replaced: a trigger inside a `FormField`
  // is already described by its hint, and losing that to gain this is not an improvement.
  const described = children.props['aria-describedby'];
  const describedBy = open ? [described, id].filter(Boolean).join(' ') : described;

  return (
    /*
     * THE HANDLERS ARE ON THE WRAPPER, WHICH IS ALSO THE HOVER BRIDGE. `focusin`/`focusout` (React's
     * `onFocus`/`onBlur`) and `mouseover`/`mouseout` all bubble from the trigger, so binding here reads
     * the trigger's events without touching its props — and because the bubble is a DOM DESCENDANT of
     * this wrapper, moving the pointer from the trigger onto the bubble does not fire `onMouseLeave`.
     * That is WCAG 1.4.13 Hoverable, and it is why the bubble is not `pointer-events-none`: the pointer
     * has to be able to rest on additional content it may need to read.
     */
    <span
      className="relative inline-flex"
      onMouseEnter={openAfterDelay}
      onMouseLeave={close}
      onFocus={openNow}
      onBlur={close}
    >
      {cloneElement(children, { 'aria-describedby': describedBy })}
      {open && (
        /*
         * UNMOUNTED WHEN CLOSED, not hidden. A bubble left in the DOM under `hidden` or an opacity class
         * is still a described-by target and still reachable by a screen reader's own navigation, which
         * turns "extra help on request" into a sentence stuck to the control forever. `role="tooltip"`
         * therefore exists exactly while `aria-describedby` points at it.
         *
         * The positioned span reaches down to the trigger's edge and the padding makes the visible gap,
         * so the hover bridge stays contiguous — a `mb-1.5` here would open a dead strip that dismisses
         * the bubble on the way to it.
         */
        <span
          role="tooltip"
          id={id}
          className={cn(
            'absolute left-1/2 z-30 -translate-x-1/2',
            placement === 'top' ? 'bottom-full pb-1.5' : 'top-full pt-1.5',
          )}
        >
          {/*
           * Theme-inverting tokens, the same pair `Button`'s default variant uses, so the bubble reads
           * as foreground on both themes rather than being legible on one. The fade is
           * `animate-tooltip-in`, a token in globals.css that the same file switches to `none` under
           * `prefers-reduced-motion: reduce` — a `motion-reduce:` variant here would be a second
           * opinion about a rule the sheet already owns. It was `animate-in fade-in-0 … duration-100`,
           * which is tailwindcss-animate syntax for a plugin this repo does not depend on: no CSS was
           * generated, so there was no fade to collapse.
           */}
          <span className="block w-max max-w-xs animate-tooltip-in rounded-md bg-fg px-2 py-1 text-xs leading-snug text-surface shadow-lg">
            {content}
          </span>
        </span>
      )}
    </span>
  );
}
