// @vitest-environment jsdom
/**
 * DateRangePicker — the two rules a pair of `type="date"` inputs cannot enforce.
 *
 * The value is always an ORDERED pair (the AUTO-SWAP rule), and nothing is committed until both
 * ends are complete — so a caller never stores a half-typed date. Everything else here pins the
 * calendar's keyboard story, because a picker that only answers a mouse is a filter nobody on a
 * keyboard can close.
 *
 * THE CLOCK IS FAKED, and it is not ceremony: with no value set the calendar opens on the month
 * containing TODAY, so an unfaked run tests a different grid every month and `11 March` exists only
 * in March. Pinned to 10 March 2026, every case below sees the same grid all year.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DateRangePicker, type DateRange } from './date-range-picker';

const MARCH = { from: '2026-03-04', to: '2026-03-11' };

/** A real controlled parent: every commit feeds back through state, as a form would. */
function setup(initial: DateRange | null = MARCH, props: Record<string, unknown> = {}) {
  const onChange = vi.fn();
  function Wrapper() {
    const [value, setValue] = useState<DateRange | null>(initial);
    return (
      <DateRangePicker
        value={value}
        onChange={(v) => {
          onChange(v);
          setValue(v);
        }}
        {...props}
      />
    );
  }
  render(<Wrapper />);
  return { onChange };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-03-10T12:00:00'));
});

afterEach(() => {
  vi.useRealTimers();
});

const fromField = () => screen.getByLabelText('From date') as HTMLInputElement;
const toField = () => screen.getByLabelText('To date') as HTMLInputElement;
const dialog = () => screen.getByRole('dialog', { name: 'Choose date range' });
/**
 * jsdom's native `.focus()` moves `document.activeElement` but never reaches React's `onFocus`, and
 * `fireEvent.focus` reaches React but never moves real focus — opening a picker needs BOTH, which is
 * exactly the split a real browser hides.
 */
function openCalendar(field: HTMLInputElement) {
  field.focus();
  fireEvent.focus(field);
}
const day = (name: string) => screen.getByRole('button', { name });

describe('DateRangePicker', () => {
  it('shows the value in the two fields, and no calendar until asked', () => {
    setup();
    expect(fromField().value).toBe('2026-03-04');
    expect(toField().value).toBe('2026-03-11');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens on focus, closes on Escape, and does not reopen itself while handing focus back', () => {
    setup();
    openCalendar(fromField());
    expect(dialog()).toBeInTheDocument();

    fireEvent.keyDown(fromField(), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // Focus RETURNS to the field that opened it — and that must not read as "open me" again.
    expect(fromField()).toHaveFocus();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('closes from the grid too, and on an outside click', () => {
    setup();
    openCalendar(fromField());
    fireEvent.keyDown(dialog(), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    openCalendar(fromField());
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens on the month holding today when there is no value yet', () => {
    setup(null);
    openCalendar(fromField());
    expect(screen.getByText('March 2026')).toBeInTheDocument();
    // Whatever day the suite runs on, the grid says which one it is.
    expect(
      screen.getByRole('button', { name: '10 March 2026', current: 'date' }),
    ).toBeInTheDocument();
  });

  it('ArrowDown enters the grid; arrows move a day and a week', () => {
    setup();
    openCalendar(fromField());

    fireEvent.keyDown(fromField(), { key: 'ArrowDown' });
    // The grid, not the field: the roving focus starts on the range's first day.
    expect(day('4 March 2026')).toHaveFocus();

    fireEvent.keyDown(dialog(), { key: 'ArrowRight' });
    expect(day('5 March 2026')).toHaveFocus();

    fireEvent.keyDown(dialog(), { key: 'ArrowDown' });
    // ±7, so a keyboard user moves a week the way the rows are laid out.
    expect(day('12 March 2026')).toHaveFocus();
  });

  it('picks a one-day window first and holds the calendar open for the second click', () => {
    const { onChange } = setup(null);
    openCalendar(fromField());

    fireEvent.click(day('11 March 2026'));
    expect(onChange).toHaveBeenLastCalledWith({ from: '2026-03-11', to: '2026-03-11' });
    expect(dialog()).toBeInTheDocument();
  });

  it('orders the pair when the second click lands BEFORE the first — the auto-swap rule', () => {
    const { onChange } = setup(null);
    openCalendar(fromField());

    // fireEvent (not raw .click()), so React flushes between the two picks and the second sees the
    // anchor the first set — the way two separate clicks land in a browser.
    fireEvent.click(day('11 March 2026'));
    fireEvent.click(day('5 March 2026'));

    // The user meant Wed the 11th back to Thu the 5th; the pair is emitted ordered, not rejected.
    expect(onChange).toHaveBeenLastCalledWith({ from: '2026-03-05', to: '2026-03-11' });
    // A completed window closes the picker and hands focus back — the keyboard path is clear again.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(fromField()).toHaveFocus();
  });

  it('commits a complete typed pair, and swaps a typed end that lands before the other', () => {
    const { onChange } = setup({ from: '2026-03-10', to: '2026-03-20' });

    fireEvent.change(fromField(), { target: { value: '2026-03-25' } });
    expect(onChange).toHaveBeenLastCalledWith({ from: '2026-03-20', to: '2026-03-25' });
  });

  it('does not commit half a pair, and does not call half-typing an error', () => {
    const { onChange } = setup(null);

    fireEvent.change(fromField(), { target: { value: '2026-03' } });
    expect(onChange).not.toHaveBeenCalled();
    // Incomplete is not invalid: the field is still being typed into.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(fromField()).not.toHaveAttribute('aria-invalid');
  });

  it('refuses a complete impossible date, announces it, and reverts on blur', () => {
    const { onChange } = setup(MARCH);

    fireEvent.change(toField(), { target: { value: '2026-02-31' } });
    // Feb 31 is well-formed ISO and no real day — the parse round-trip is what catches it.
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Not a real calendar date.');
    expect(toField()).toHaveAttribute('aria-invalid', 'true');

    fireEvent.blur(toField());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(toField().value).toBe('2026-03-11');
  });

  it('refuses a date the window forbids, with the same hold-and-announce treatment', () => {
    const { onChange } = setup(MARCH, { max: '2026-03-31' });

    fireEvent.change(toField(), { target: { value: '2026-04-01' } });
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('That date is outside the allowed window.');
  });

  it('disables days outside min/max and days the caller disables', () => {
    setup(MARCH, {
      min: '2026-03-05',
      max: '2026-03-20',
      isDisabled: (iso: string) => iso === '2026-03-13',
    });
    openCalendar(fromField());

    // The ATTRIBUTE, not a click: jsdom dispatches clicks a real browser would never send.
    expect(day('4 March 2026')).toBeDisabled();
    expect(day('21 March 2026')).toBeDisabled();
    expect(day('13 March 2026')).toBeDisabled();
    expect(day('10 March 2026')).not.toBeDisabled();
  });

  it('clears to null, which is the only way a caller learns the window was abandoned', () => {
    const { onChange } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Clear dates' }));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('turns months with the Page keys, and refuses a month with nothing selectable', () => {
    setup(MARCH, { max: '2026-03-31' });
    openCalendar(fromField());

    expect(screen.getByText('March 2026')).toBeInTheDocument();
    // Every day of April is past `max`, so the chevron into it is dead rather than a wall of grey.
    expect(screen.getByRole('button', { name: 'Next month' })).toBeDisabled();

    fireEvent.keyDown(dialog(), { key: 'PageUp' });
    expect(screen.getByText('February 2026')).toBeInTheDocument();

    fireEvent.keyDown(dialog(), { key: 'PageDown' });
    expect(screen.getByText('March 2026')).toBeInTheDocument();
  });

  it('marks the endpoints as selected; a middle day is part of the window, not selected', () => {
    setup(MARCH);
    openCalendar(fromField());

    expect(day('4 March 2026')).toHaveAttribute('aria-selected', 'true');
    expect(day('11 March 2026')).toHaveAttribute('aria-selected', 'true');
    expect(day('6 March 2026')).not.toHaveAttribute('aria-selected');
  });
});
