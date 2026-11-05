/**
 * Status → tone, for the vocabularies that appear on more than one screen.
 *
 * WHY A MAP OF TONES AND NOT OF CLASSES
 * -------------------------------------
 * Twelve sites wrote the badge's Tailwind classes inline — `bg-warning-bg text-warning` and friends —
 * so the same word was a different colour on different screens: `pending` was amber in the inbox and
 * neutral on the access screen, and `high` severity was `bg-orange-50 text-orange-700`, a raw palette
 * value in a codebase whose whole point is semantic tokens that flip in dark mode. (That one did not
 * flip. It was unreadable on a dark background.)
 *
 * A tone, not a class: `Badge` owns what a tone LOOKS like, and this owns which tone a word MEANS.
 * Those are different decisions and the split is what stops a new page inventing a third orange.
 *
 * WHAT BELONGS HERE. Only vocabularies shared by two or more screens — approval statuses, severities,
 * lifecycle states. A vocabulary used on exactly one screen stays there, next to the page that reads
 * it: moving it here would make this file the place every enum in the product accumulates, and a
 * lookup table nobody can attribute to a caller is worse than a local one.
 */
import type { BadgeTone } from './badge';
import { EM_DASH } from '@/shared/lib/format';

/**
 * The request-engine decision states, and the domain statuses that mirror them.
 *
 * Shared by the inbox, access requests, workforce (leave, overtime, timesheets), catalog requests and
 * performance reviews — five screens that were each choosing their own colours for the same five
 * words.
 *
 * `pending` is AMBER rather than neutral: it is the state that needs somebody to act, and the whole
 * reason those screens exist is to surface it.
 */
export const APPROVAL_TONE: Record<string, BadgeTone> = {
  draft: 'neutral',
  pending: 'amber',
  pending_approval: 'amber',
  submitted: 'blue',
  in_review: 'blue',
  approved: 'green',
  completed: 'green',
  resolved: 'green',
  acknowledged: 'blue',
  rejected: 'red',
  cancelled: 'neutral',
  expired: 'neutral',
};

/**
 * Severity and risk grades, worst first.
 *
 * `critical` and `high` are BOTH red, and that is deliberate: the palette has one "this is bad"
 * colour, and splitting it into red-and-orange put a raw `orange-700` into the one screen that tried
 * — which then did not flip in dark mode. The distinction is carried by the WORD, which is why
 * `StatusBadge` always renders text and never colour alone.
 *
 * TWO PAGES USED TO DISAGREE WITH THIS. `incident.types.ts` and `vendor.types.ts` each carried a
 * byte-identical local function mapping `high` to amber, `medium` to blue and everything else to
 * neutral — so one severity had two colours depending on which screen you were looking at, and the
 * split this map exists to prevent was live on two of them. Both are gone; those pages call
 * `statusTone` like the other thirty.
 *
 * Vendor CRITICALITY comes through here too. It is a different word for the same shape of judgement —
 * how bad is this — and giving it its own colour scale would mean a reader learning two.
 */
export const SEVERITY_TONE: Record<string, BadgeTone> = {
  critical: 'red',
  high: 'red',
  major: 'red',
  medium: 'amber',
  moderate: 'amber',
  minor: 'amber',
  low: 'blue',
  observation: 'neutral',
  info: 'neutral',
};

/** Whether a thing is in service: employees, assets, roles, vendors, controlled documents. */
export const LIFECYCLE_TONE: Record<string, BadgeTone> = {
  active: 'green',
  // Shared by licences and employment contracts: both have a window that is about to close, and both
  // were choosing their own amber for it.
  expiring_soon: 'amber',
  expired: 'red',
  published: 'green',
  open: 'amber',
  onboarding: 'blue',
  in_progress: 'blue',
  suspended: 'amber',
  on_leave: 'amber',
  archived: 'neutral',
  retired: 'neutral',
  closed: 'neutral',
  superseded: 'neutral',
  terminated: 'red',
  offboarded: 'red',
  void: 'red',
  // The quality loop, shared by the non-conformance register and the CAPA queue.
  //
  // `contained` is BLUE and not green: the bleeding stopped, which is progress and not resolution — the
  // finding is still open work until it closes. `verified` is the only green in this set, because it is the
  // only state that means the corrective action was shown to work, and `ineffective` is amber rather than
  // red: it sends the CAPA back to analysis, so it is a loop and not a failure to be written off.
  contained: 'blue',
  analysis: 'amber',
  planned: 'blue',
  implemented: 'blue',
  verified: 'green',
  ineffective: 'amber',
};

/**
 * Look a status up across the shared vocabularies, falling back to neutral.
 *
 * Neutral rather than throwing: a status the UI has never heard of is a new enum value from a
 * deployed API, and a grey badge showing the raw word is a far better outcome than a blank cell or a
 * crashed page. The word is always rendered, so nothing is hidden by the fallback.
 */
export function statusTone(status: string | null | undefined): BadgeTone {
  if (!status) return 'neutral';
  const key = status.toLowerCase();
  return APPROVAL_TONE[key] ?? SEVERITY_TONE[key] ?? LIFECYCLE_TONE[key] ?? 'neutral';
}

/** `needs_improvement` → `Needs improvement`. The label every enum needs and no page should retype. */
export function humanizeStatus(status: string | null | undefined): string {
  if (!status) return EM_DASH;
  const spaced = status.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
