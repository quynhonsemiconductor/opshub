// @vitest-environment jsdom
/**
 * DurationInput — minutes underneath, hours + minutes on the surface.
 *
 * The property everything else hangs off: `onChange` fires with MINUTES or not at all. Invalid or
 * out-of-bounds typing is HELD in the field and announced with `role="alert"`, never clamped and
 * never committed — a control that quietly rewrites what somebody typed is not a control they
 * correct, it is one they fight.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { DurationInput } from './duration-input';

/** A real controlled parent: every commit feeds back through state, as a form would. */
function setup(initial: number, props: Record<string, unknown> = {}) {
  const onChange = vi.fn();
  function Wrapper() {
    const [value, setValue] = useState(initial);
    return (
      <DurationInput
        value={value}
        onChange={(minutes) => {
          onChange(minutes);
          setValue(minutes);
        }}
        {...props}
      />
    );
  }
  render(<Wrapper />);
  return { onChange };
}

const hours = () => screen.getByLabelText('Duration, hours') as HTMLInputElement;
const minutes = () => screen.getByLabelText('Duration, minutes') as HTMLInputElement;

describe('DurationInput', () => {
  it('splits a minutes value across a clock-style pair of named fields', () => {
    setup(510);
    expect(hours().value).toBe('8');
    expect(minutes().value).toBe('30');
    // Half a shift, not a decimal: `8h 30m` is the way the value is read aloud, so it is the way
    // it is shown. Both fields are named — "Duration, hours" — so a screen reader says the unit.
  });

  it('commits the total in minutes as the hours change', () => {
    const { onChange } = setup(510);
    fireEvent.change(hours(), { target: { value: '2' } });
    // 2h + the 30m already there — the field the user did NOT touch keeps its value.
    expect(onChange).toHaveBeenLastCalledWith(150);
    expect(hours().value).toBe('2');
  });

  it('commits from the minutes field too, carrying the hours', () => {
    const { onChange } = setup(480);
    fireEvent.change(minutes(), { target: { value: '45' } });
    // 8h + the 45m just typed — the untouched hours field is carried, not reset.
    expect(onChange).toHaveBeenLastCalledWith(525);
  });

  it('reads an empty field as zero, not as a mistake', () => {
    const { onChange } = setup(510);
    fireEvent.change(hours(), { target: { value: '' } });
    // Clearing hours means "no hours": 0h 30m is what the pair now says, so it is what is committed.
    expect(onChange).toHaveBeenLastCalledWith(30);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('holds and announces minutes above 59, flagging only the field that caused it', () => {
    const { onChange } = setup(0);
    fireEvent.change(minutes(), { target: { value: '90' } });

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Minutes must be a whole number between 0 and 59.',
    );
    expect(minutes()).toHaveAttribute('aria-invalid', 'true');
    expect(hours()).not.toHaveAttribute('aria-invalid');
    // And the typed text is still there to be corrected, not rewritten under the cursor.
    expect(minutes().value).toBe('90');
  });

  it('drops the draft on blur, so the fields show the controlled value again', () => {
    setup(0);
    fireEvent.change(minutes(), { target: { value: '90' } });
    fireEvent.blur(minutes());
    expect(minutes().value).toBe('0');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('explains a floor instead of silently clamping up to it', () => {
    const { onChange } = setup(480, { min: 240 });
    fireEvent.change(hours(), { target: { value: '1' } });

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Duration must be at least 4h.');
    // The total is both fields' product, so both carry the flag.
    expect(hours()).toHaveAttribute('aria-invalid', 'true');
    expect(minutes()).toHaveAttribute('aria-invalid', 'true');
  });

  it('explains a ceiling, spelled by the same formatter as the hint would be', () => {
    const { onChange } = setup(60, { max: 510 });
    fireEvent.change(hours(), { target: { value: '9' } });

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Duration must be at most 8h 30m.');
  });

  it('commits a preset and marks the active one, and only that one', () => {
    const { onChange } = setup(480, {
      presets: [
        { label: '4h', minutes: 240 },
        { label: '8h', minutes: 480 },
      ],
    });

    expect(screen.getByRole('button', { name: '8h' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '4h' })).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(screen.getByRole('button', { name: '4h' }));
    expect(onChange).toHaveBeenLastCalledWith(240);
    // The controlled parent committed, so the pressed state moved with it.
    expect(screen.getByRole('button', { name: '4h' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '8h' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('names the group after ariaLabel, so two durations on one form do not blur together', () => {
    render(<DurationInput value={90} onChange={vi.fn()} ariaLabel="Estimated effort" />);
    expect(screen.getByLabelText('Estimated effort, hours')).toBeInTheDocument();
    expect(screen.getByLabelText('Estimated effort, minutes')).toBeInTheDocument();
  });

  it('shows the caller’s error instead of the built-in one', () => {
    setup(480, { error: 'Cannot overlap the on-call window.' });
    expect(screen.getByRole('alert')).toHaveTextContent('Cannot overlap the on-call window.');
  });
});
