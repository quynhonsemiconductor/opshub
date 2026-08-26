// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DecisionNote } from './decision-note';
import { decisionNoteText } from './decision-reason';

/**
 * The two sentences, and the three cases that must stay silent.
 *
 * This is the kind of component whose bug is a rendered sentence that is WRONG rather than a crash, so
 * every case asserts the exact text. `not_open` is the one worth the most: a closed request rendering
 * "Not yours to decide" states a rule that is not the one in force, and that is precisely what a
 * two-branch ternary produces — which is what both call sites had before this existed.
 */
/**
 * NOTHING, not an empty sentence.
 *
 * `textContent === ''` was the first assertion here and it is not enough: dropping the component's
 * `if (!note) return null` renders `<span class="text-xs text-fg-subtle" />`, whose textContent is also
 * empty — the mutation SURVIVED. An empty span is a real node in the flex row these sit in, so it can
 * take gap spacing and put a stray box in a row that should be blank. Assert the element is absent.
 */
function expectRendersNothing(container: HTMLElement): void {
  expect(container.firstChild).toBeNull();
  expect(container.querySelector('span')).toBeNull();
}

describe('DecisionNote', () => {
  it('tells a requester that somebody else decides', () => {
    render(<DecisionNote reason="own_request" />);
    expect(screen.getByText('Yours — a colleague decides')).toBeTruthy();
  });

  it('tells a caller without the permission that it is not theirs', () => {
    render(<DecisionNote reason="missing_permission" />);
    expect(screen.getByText('Not yours to decide')).toBeTruthy();
  });

  it('says NOTHING about a request that is merely closed', () => {
    // Not "Not yours to decide". A decided record is finished and no property of the reader is why.
    const { container } = render(<DecisionNote reason="not_open" />);
    expectRendersNothing(container);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
  ])('renders nothing when the reason is %s', (_label, reason) => {
    // Nullable on the wire, absent on a row the engine never evaluated. Neither is a sentence.
    const { container } = render(<DecisionNote reason={reason} />);
    expectRendersNothing(container);
  });

  it('is styled as a subtle inline note, not as a control', () => {
    // The classes are the reason this is shared: seven hand-written copies of them is what it replaced.
    const { container } = render(<DecisionNote reason="own_request" />);
    const span = container.querySelector('span');
    expect(span?.className).toContain('text-fg-subtle');
    expect(container.querySelector('button')).toBeNull();
  });

  describe('decisionNoteText', () => {
    it('returns the sentence for the two reasons that have one, and null otherwise', () => {
      expect(decisionNoteText('own_request')).toBe('Yours — a colleague decides');
      expect(decisionNoteText('missing_permission')).toBe('Not yours to decide');
      expect(decisionNoteText('not_open')).toBeNull();
      expect(decisionNoteText(null)).toBeNull();
      expect(decisionNoteText(undefined)).toBeNull();
    });
  });
});
