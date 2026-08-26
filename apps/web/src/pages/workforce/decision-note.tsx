import { decisionNote, type DecisionVerdict } from './workforce-policy';

/**
 * The line that stands in for a decision the viewer cannot make.
 *
 * WHY IT IS A COMPONENT. Six places need it — the row-actions cell and the detail drawer on each of the
 * leave, overtime and timesheet tabs — and the kit's own history says what happens otherwise: six
 * hand-written copies of the same `text-xs text-fg-subtle`, which is how `IconAction` came to exist. The
 * wording is a product decision shared with the requests inbox, so it should be changeable in one edit.
 *
 * Renders nothing for the verdicts that have nothing to explain, so callers can hand it any verdict and
 * do not each need to know which two of the five carry a sentence.
 */
export function DecisionNote({ verdict }: { verdict: DecisionVerdict }) {
  const note = decisionNote(verdict);
  if (!note) return null;
  return <span className="text-xs text-fg-subtle">{note}</span>;
}
