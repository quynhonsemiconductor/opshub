// @vitest-environment jsdom
/**
 * The five properties that separate a tooltip from a hover-only `<div>`.
 *
 * Every one of them is a thing the `title` attribute this replaces got wrong, and every one was
 * mutation-tested: the focus handler, the `aria-describedby`, the Escape listener and the unmount-when-
 * closed were each removed in turn, and the assertion below failed. A test that passes with the
 * behaviour deleted is not pinning the behaviour.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Modal } from './modal';
import { Tooltip } from './tooltip';

function Subject({ content = 'Pulls the latest score from Microsoft Graph.' } = {}) {
  return (
    <Tooltip content={content}>
      <button type="button">Sync now</button>
    </Tooltip>
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe('Tooltip', () => {
  it('opens on FOCUS, with no delay to wait out', () => {
    // The whole reason this is a component. A keyboard user never fires `mouseenter`, so a hover-only
    // implementation is help for people who already had the mouse.
    render(<Subject />);
    fireEvent.focus(screen.getByRole('button', { name: 'Sync now' }));

    expect(screen.getByRole('tooltip').textContent).toContain('Microsoft Graph');
  });

  it('opens on HOVER, but only once the pointer has rested', () => {
    vi.useFakeTimers();
    render(<Subject />);
    fireEvent.mouseEnter(screen.getByRole('button', { name: 'Sync now' }));

    // The delay is deliberate and therefore pinned in both directions: a pointer crossing a row on its
    // way elsewhere must not light up every trigger it passes.
    expect(screen.queryByRole('tooltip')).toBeNull();

    // `act`, because the open is a state update fired from a TIMER rather than from an event React is
    // already inside — without it the timer runs, the bubble renders on the next tick, and the query
    // below reads the DOM one frame too early.
    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.getByRole('tooltip').textContent).toContain('Microsoft Graph');
  });

  it('abandons a pending hover when the pointer leaves before the delay elapses', () => {
    vi.useFakeTimers();
    render(<Subject />);
    const trigger = screen.getByRole('button', { name: 'Sync now' });

    fireEvent.mouseEnter(trigger);
    fireEvent.mouseLeave(trigger);
    act(() => vi.advanceTimersByTime(1_000));

    // Without the timer being cancelled the bubble appears over whatever the pointer moved on to.
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('points aria-describedby at the LIVE tooltip element', () => {
    render(<Subject />);
    const trigger = screen.getByRole('button', { name: 'Sync now' });
    fireEvent.focus(trigger);

    /*
     * Not "has the attribute": the id has to RESOLVE to the element carrying the sentence. A dangling
     * reference is dropped silently by assistive tech, so the failure mode this guards against looks
     * identical in the DOM and announces nothing.
     */
    const described = trigger.getAttribute('aria-describedby');
    expect(described).toBeTruthy();
    const target = document.getElementById(described!);
    expect(target).toBe(screen.getByRole('tooltip'));
    expect(target!.textContent).toContain('Microsoft Graph');
  });

  it('keeps a hint the trigger already had, rather than replacing it', () => {
    render(
      <Tooltip content="Extra">
        <button type="button" aria-describedby="existing-hint">
          Save
        </button>
      </Tooltip>,
    );
    const trigger = screen.getByRole('button', { name: 'Save' });
    fireEvent.focus(trigger);

    // A trigger inside a `FormField` is already described by its hint. Losing that to gain this is not
    // an improvement, so the attribute is appended to.
    const described = trigger.getAttribute('aria-describedby')!.split(' ');
    expect(described).toContain('existing-hint');
    expect(described).toContain(screen.getByRole('tooltip').id);
  });

  it('is dismissed by Escape while it is showing', () => {
    // WCAG 1.4.13 Dismissible. `title` offers no way to do this at all.
    render(<Subject />);
    const trigger = screen.getByRole('button', { name: 'Sync now' });
    fireEvent.focus(trigger);
    expect(screen.getByRole('tooltip')).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('gives Escape to the tooltip only, not to the dialog underneath it', () => {
    /*
     * The same nesting bug `useEscapeToClose` was written for, one rung further in: the modal listens on
     * the document in the bubble phase, so one keypress used to be answerable twice — dismiss the bubble
     * AND close the dialog the reader was still filling in.
     */
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="Renew licence">
        <Tooltip content="Cost is per seat, per month.">
          <button type="button">Renew</button>
        </Tooltip>
      </Modal>,
    );
    fireEvent.focus(screen.getByRole('button', { name: 'Renew' }));

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('is absent from the accessibility tree until asked for, and again after', () => {
    render(<Subject />);
    const trigger = screen.getByRole('button', { name: 'Sync now' });

    /*
     * UNMOUNTED, not hidden. A bubble parked in the DOM behind an opacity class is still a described-by
     * target and still reachable by a screen reader's own navigation, which turns help-on-request into a
     * sentence welded to the control.
     */
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(trigger.getAttribute('aria-describedby')).toBeNull();

    fireEvent.focus(trigger);
    expect(screen.getByRole('tooltip')).toBeTruthy();

    fireEvent.blur(trigger);
    expect(screen.queryByRole('tooltip')).toBeNull();
    // And the reference goes with it: a description pointing at nothing is worse than none, because it
    // reads as wired.
    expect(trigger.getAttribute('aria-describedby')).toBeNull();
  });
});
