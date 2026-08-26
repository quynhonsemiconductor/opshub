import { decisionNoteText, type CannotDecideReason } from './decision-reason';

/**
 * The line that stands in for a decision the viewer cannot make.
 *
 * The vocabulary, the two sentences and the reason `not_open` is silent all live in `decision-reason.ts`
 * — see that file for why they are shared at all. This is only how the note looks: a subtle inline note
 * and not a control, because there is nothing here to click.
 *
 * Renders nothing for the reasons that have nothing to explain, so a caller can hand it any reason and
 * does not need to know which of them carry a sentence.
 */
export function DecisionNote({ reason }: { reason: CannotDecideReason }) {
  const note = decisionNoteText(reason);
  if (!note) return null;
  return <span className="text-xs text-fg-subtle">{note}</span>;
}
