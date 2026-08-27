/**
 * Why a viewer may not decide something, and the sentence that says so.
 *
 * SPLIT FROM `decision-note.tsx` for the reason `status-tone.ts` is split from `status-badge.tsx`: a file
 * that exports a component and a plain function breaks Fast Refresh, and `react-refresh/only-export-
 * components` says so as a warning the commit hook treats as an error. The component owns what the note
 * LOOKS like; this owns which sentence a reason MEANS.
 *
 * Two unrelated families need the same two sentences about the same fact: the requests inbox, where the
 * engine reports why the viewer may not decide, and the workforce leave, overtime and timesheet tabs,
 * which compute the same verdict locally because those screens read domain tables rather than the engine.
 * That was seven hand-written copies of two strings, and the workforce copy's docblock claimed the
 * wording was "changeable in one edit" while the inbox held its own. It is one edit now.
 *
 * KEYED ON THE ENGINE'S OWN VOCABULARY rather than a new one. `viewerCannotDecideReason` is a field on
 * the requests API and `RequestEngineService` is what produces it, so it is the vocabulary that already
 * exists; a second set of names here would mean every caller translates twice.
 */

/**
 * Why the viewer may not decide, in the request engine's words.
 *
 * `null` and `undefined` are both "no reason given" — the field is nullable on the wire and absent on a
 * row the engine did not evaluate, and neither is something to render.
 */
export type CannotDecideReason =
  'own_request' | 'missing_permission' | 'not_open' | null | undefined;

/**
 * `not_open` has no entry ON PURPOSE. A decided, withdrawn or expired record is finished, and nothing
 * about the reader is why they cannot act on it — the honest cell is empty. Saying "not yours to decide"
 * about a request that is simply closed states a rule that is not the one in force.
 *
 * "Ask a colleague" and "ask for access" are different next actions, which is the whole reason this is
 * not a blank cell — and why the two reasons are not collapsed into one apologetic sentence.
 */
const NOTE: Record<'own_request' | 'missing_permission', string> = {
  own_request: 'Yours — a colleague decides',
  missing_permission: 'Not yours to decide',
};

/** The sentence, or `null` when the right answer is to render nothing. */
export function decisionNoteText(reason: CannotDecideReason): string | null {
  return reason === 'own_request' || reason === 'missing_permission' ? NOTE[reason] : null;
}
