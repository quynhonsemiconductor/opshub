/// <reference types="node" />
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Frontend-consistency ratchets — guardrails for the component-system migration.
 *
 * Each baseline is frozen at the CURRENT count and may only ever DECREASE as pages adopt the
 * shared primitives. A rising count means new code re-hand-rolled something the design
 * system already owns: fix the code, not the baseline.
 *
 * Ported from rally, and its docblock carries the lesson that shaped this file. Four of
 * rally's six baselines had drifted well ABOVE the real count, so 39 new violations could
 * have landed green — "a ratchet with slack in it is not a ratchet; it is a comment". Every
 * number below was therefore measured by forcing it to -1 and reading the count the failure
 * reports, never by grepping alongside, because an approximate grep sets the bar in the
 * wrong place.
 *
 * TWO OF RALLY'S SIX CHECKS ARE DELIBERATELY ABSENT, because opshub has nowhere for those
 * violations to go and a ratchet pointing at a destination that does not exist is worse than
 * none — it implies a migration nobody can perform:
 *
 *  - raw Tailwind font sizes (`text-sm`, `text-lg`, …). rally routes type through a
 *    `text-ui-*` scale in its `@theme`. opshub's globals.css defines no such scale, and
 *    there are 692 occurrences — freezing that would pin a number with no migration path.
 *    Add the scale first, then add the check.
 *  - hardcoded JSX copy. rally's proxy for un-internationalised text assumes a `t()` to wire
 *    it through. opshub has no i18n layer at all.
 */

// ── Baselines — LOWER as the migration proceeds, NEVER raise ───────────────────
//
// `<button>` has a destination: shared/ui/button.tsx. 149 → 105 (access, compliance, workforce) →
// 93 (people) → 78 (rbac) → 72 (finops) → 59 (assets, requests, catalog) → 45 (profile, webhooks,
// audit logs, security posture, reports) → 40, once `stripComments` stopped counting prose ABOUT the
// rule as a violation OF it. Re-measured each time the way this file's docblock demands: force the
// constant to -1 and read the count the failure reports.
//
// 40 → 38, because promoting workforce's `RowAction` and `PanelAction` into the kit rebuilt them on
// `Button`: two components carrying their own tone maps became none, and every caller lost a raw button.
//
// 38 → 36 (requests). Its approve/reject cell was two hand-rolled buttons carrying their own colour
// classes — `text-success`/`hover:bg-success-bg` and the danger pair — which is exactly the per-page tone
// map `RowAction` exists to remove. Found while adding the withdraw action beside them.
//
// 36 → 32 (access). Four more of the same: an approve/reject pair in the row cell and another in the drawer
// header, each carrying its own `bg-success-bg`/`text-success` classes. `RowAction` and `PanelAction` are the
// pair that already own those tones. Found while adding the standing-grants panel to that screen.
//
// The 32 that remain are mostly inside `shared/ui` itself, where a `<button>` IS the primitive, plus a
// few widgets (the notification bell, the AI panel, the app shell's own nav) that were never screens.
// Worth checking what is actually left before assuming the number can keep falling.
const MAX_RAW_BUTTON = 7;
// Inline style is nearly clean already. Static colour and spacing belong in token utilities;
// the residue is data-driven (a computed width, a chart dimension).
const MAX_INLINE_STYLE = 4;
/**
 * Arbitrary `text-[10px]`-style values. MAY ONLY FALL — and it is at zero.
 *
 * THE NOTE HERE USED TO SAY "destination is a plain Tailwind size — this one does not need a custom
 * scale". That was wrong, and it is why the number sat at 26 for so long: twenty-three of them were
 * `text-[10px]`, Tailwind's smallest step is `text-xs` at 12px, and converting them would have grown
 * every badge, `kbd` hint and group label in the product by a fifth. There was no destination.
 *
 * So the scale gained its bottom step, `text-2xs`, and the two `11px` and one `9px` one-offs snapped to
 * a real rung rather than each earning their own. Baseline zero, because a destination now exists for
 * the size people actually reach for.
 */
const MAX_ARBITRARY_TEXT = 0;
// Largest single source file, counted as `split('\n').length` — ONE MORE than `wc -l`, which
// is worth stating because setting this from `wc -l` output puts it one below the real count
// and the ratchet fails on the file it was measured from. rally's docblock flags the same trap.
// pages/people/people-page.tsx. Pages are composition; a file this size is doing more than
// composing. The generated API client is excluded — it is 7575 lines and not hand-written.
//
// THIS CEILING EARNED ITS KEEP. The workforce conversion produced a single 1272-line file and this
// check refused it, correctly: four forms, four tables and four drawers in one file is four screens
// sharing a filename. It is now six modules, the largest 343 lines.
//
// 1082 → 907 → 818 → 725 → 499 → 497. Each number in turn described the largest hand-written screen,
// and each of those is now a folder of modules: people (315-line shell), settings/rbac (51), dashboard
// (86), finops (209), reports (77).
//
// Reports was split BECAUSE OF THIS CHECK and not because it grew a feature: the comments explaining
// its colour change pushed it past 499, the ceiling refused, and the honest response was three modules
// rather than a bigger number.
//
// 497 → 486. It refused again at 498, on `compliance-page.tsx`, for one wrapped line added while routing
// its toast through `apiErrorMessage`. The honest response was the same: its resolve dialog moved to
// `compliance/compliance-modals.tsx`, where every other screen in this migration keeps its dialogs. The
// ceiling now describes `reports/report-charts.tsx`.
const MAX_FILE_LINES = 486;

/**
 * Hand-rolled modal overlays — a `fixed inset-0 z-50` backdrop built inline instead of using
 * `shared/ui/modal.tsx`. MAY ONLY FALL.
 *
 * 11 of the 12 modals in the SPA do this, and `Modal` is the only component that sets
 * `role="dialog"` / `aria-modal`, so none of those 11 are announced as dialogs to a screen reader
 * and none inherit its focus handling. Found while writing `apps/web/e2e/workforce-leave.e2e.ts`,
 * where `page.getByRole('dialog')` matched nothing on an open modal — a browser test failing to
 * find a dialog is the same signal assistive tech gets.
 *
 * Twelve copies of backdrop markup is also the duplication `Modal` exists to remove.
 *
 * 11 → 8: access, compliance and workforce (which held FOUR of them) now use `Modal`, so those
 * dialogs are announced as dialogs, trap focus and close on Escape. People was already on `Modal` for
 * two of its three, so that conversion did not move the number; rbac's three took it to 7, finops' one
 * to 6, assets + requests + catalog to 3, and profile + webhooks to ZERO.
 *
 * THIS IS NOW A FLOOR. Every dialog in the SPA goes through `shared/ui/modal.tsx`, so any new
 * `fixed inset-0 z-50` outside the exemption below fails the build. That is the end state this ratchet
 * was created to reach.
 */
const MAX_HANDROLLED_MODAL = 0;

/**
 * Invented failure messages — `toast.error('…')` with a hand-written sentence instead of
 * `apiErrorMessage(error, …)`. MAY ONLY FALL.
 *
 * The API answers a refused mutation with a code and a sentence naming the record and the rule. Fifteen
 * screens threw that away and substituted a guess, and a guess is worse than nothing when it is wrong:
 * the contracts screen showed "The employee may already have an active contract." for a 412 whose real
 * message was "has no signature date. Supply `signedAt`" — so the activation silently never happened and
 * the message named the one cause it was not. It cost an hour of debugging a test that was correct.
 *
 * 21 → 1. The one that remains is `login-page.tsx`: a failure to START an OAuth redirect, where there is
 * no API response to read a message out of.
 *
 * A fallback sentence is still fine — `apiErrorMessage(error, 'Failed to activate the contract.')` says
 * what failed and lets the API say why. This check only refuses the shape that CANNOT show the reason.
 */
const MAX_INVENTED_ERROR_MESSAGE = 1;

/**
 * Form-level failures rendered as a bare `<p>` instead of `FormError`. MAY ONLY FALL, and is now 0.
 *
 * Seventy-two places wrote `{error && <p className="text-xs text-danger">{error}</p>}` — byte-identical,
 * every one — and not one carried `role="alert"`. The whole SPA contained two. So a submit the API
 * refused changed the screen and announced nothing: focus stays on the button, the message appears below
 * it, and a screen-reader user waits for a save that already failed.
 *
 * `FormField` had always got this right for FIELD errors, which is exactly why the gap survived — the
 * validation somebody tests with a screen reader was announced, and the API's refusal was not.
 *
 * At 0 this is a floor: the shape cannot come back without failing here.
 */
const MAX_UNANNOUNCED_FORM_ERROR = 0;

/**
 * Panels rendering their own loading / failed / empty triple instead of `PanelState`. MAY ONLY FALL.
 *
 * Twenty-five files wrote the same three-branch preamble by hand, and four got it wrong — in the one
 * direction that matters. `catalogue-tab.tsx` and both panels in `cycles-tab.tsx` had NO error branch
 * and an empty test of `!isLoading && count === 0`, which is true on failure as well, because `data` is
 * undefined and the count is therefore zero. So a failed request did not render a blank panel; it
 * asserted an absence. The performance coverage panel announced "Everybody in scope has a completed
 * review" in green — a compliance all-clear produced by a broken fetch.
 *
 * `PanelState` takes the QUERY rather than three booleans, so `isError` is always checked before
 * emptiness and a failure cannot be reported as an absence.
 *
 * 30 → 18. The remaining eighteen are all CORRECT — they handle every branch — and each carries an
 * inline comment explaining what its empty message means, which a mechanical rewrite would have
 * discarded. They are consistency debt rather than defects, so this counts them down rather than
 * failing on them.
 */
const MAX_HANDROLLED_PANEL_STATE = 18;

/**
 * Nineteen forms open-coded the modal footer, and every one of them for the same reason: `FormActions`
 * hardcoded "Saving…", so a form whose verb was "Terminate" or "Assign" could not use it without
 * lying about what it was doing. Losing the wording was the wrong trade, so they kept the wording and
 * lost the component — along with button order, variants and sizes.
 *
 * `pendingLabel` removes the reason, so the baseline is zero. A match here is a footer that could have
 * been the component.
 */
const MAX_HANDROLLED_FORM_FOOTER = 0;

/**
 * A cache window written as a number instead of a named tier. MAY ONLY FALL.
 *
 * Twenty-six queries set `staleTime` inline, in six values, and every one of them was answering the
 * same question — how out of date may this be before it misleads somebody — as a bare literal. Nothing
 * said why five minutes rather than thirty, so a new query inherited whichever number the file above
 * it happened to use. Two files had already reached for a constant and named it differently (`STALE`,
 * `URL_STALE_TIME`), both 60_000, in the same product.
 *
 * `STALE` and `POLL` name the tiers for the DATA rather than the duration, so the decision is made once
 * and a call site picks by asking what kind of thing it is reading. Baseline zero.
 */
const MAX_INLINE_CACHE_WINDOW = 0;

/**
 * An em dash written as a literal instead of `EM_DASH` / `orDash`. MAY ONLY FALL.
 *
 * Thirty-four sites wrote `?? '—'` or returned `'—'` while `format.ts` exported both the constant and
 * the helper — used in two files. It is not the character that matters: it is that "absent" has one
 * representation, decided in the place that also decides what a date and a number look like when they
 * are missing.
 *
 * `||` CHAINS ARE LEFT ALONE and use `EM_DASH` rather than `orDash`, deliberately: `orDash` treats
 * only null, undefined and the empty string as absent, and a caller chaining `value || placeholder ||
 * EM_DASH` is expressing a different fallback that the helper must not silently change.
 */
const MAX_INLINE_EM_DASH = 0;

/**
 * A date or time formatted at the call site instead of through `format.ts`. MAY ONLY FALL.
 *
 * The original 25 inline `toLocaleDateString()` calls went first, and TWO survived that migration —
 * which is exactly why this is a ratchet and not a one-off cleanup. `activity-timeline.tsx` formatted
 * in `en-US`, so an audit entry older than a month rendered `Mar 4, 2026` beside a `4 Mar 2026`
 * elsewhere in the same view; `attendance-clock.tsx` used `toLocaleTimeString([], …)`, and `[]` means
 * the browser's locale, so "Clocked in at" read `02:32 PM` on one machine and `14:32` on another.
 *
 * Both are the same defect: a second opinion about how to write a moment, in a product where the first
 * opinion is deliberate and documented.
 */
const MAX_INLINE_DATE_FORMAT = 0;

/**
 * Raw `<button>`s with NO focus rule at all. MAY ONLY FALL — and it is at zero.
 *
 * THIS IS THE DEFECT; the raw-`<button>` count above is a proxy for it. Twenty-six of the thirty-two
 * hand-rolled buttons had a `hover:` rule and no focus rule anywhere, so a keyboard user tabbing through
 * them saw nothing move. That included four of the five in the app shell and all four in the
 * notification bell — the controls reachable from every screen in the product.
 *
 * `Button` carries the ring in its base and `FOCUS_RING` names it for the few controls that should not
 * be a `Button` at all, so a match here is something built by hand that skipped both.
 *
 * WHY THE TAG IS WALKED RATHER THAN MATCHED. My first version of this used
 * `/<button[\s\S]*?>/` — non-greedy, so it stopped at the first `>`, and `onClick={() => x}` contains
 * one. Every button whose focus rule sat after any arrow function read as focus-less, which overstated
 * the original count as 29 and would have kept reporting three phantom violations forever. It now
 * tracks brace depth and quotes, so the end of the tag is the end of the tag.
 */
const MAX_UNFOCUSABLE_BUTTON = 0;

/**
 * The command palette owns its overlay, deliberately.
 *
 * It is a COMBOBOX surface, not a titled dialog: it implements `role="combobox"`, `role="option"`,
 * `aria-selected`, arrow-key navigation, Escape and a focus trap itself, and `Modal`'s header/title
 * structure is wrong for it. Exempting it by NAME rather than leaving the baseline at 1 is what keeps
 * this check a floor — a baseline of 1 would silently absorb the next real violation.
 */
const HANDROLLED_MODAL_EXEMPT = ['widgets/command-palette/'];

// this file lives in src/test/
const SRC = join(import.meta.dirname, '../');

function files(predicate: (rel: string) => boolean): string[] {
  return (
    readdirSync(SRC, { recursive: true, encoding: 'utf8' })
      .map((f) => f.split(/[\\/]/).join('/'))
      .filter((f) => /\.tsx?$/.test(f))
      .filter((f) => !/\.(test|spec)\.tsx?$/.test(f))
      .filter((f) => !/\.d\.ts$/.test(f))
      // Generated from the OpenAPI spec: not hand-written, and regenerating it must never
      // trip a style gate.
      .filter((f) => !f.startsWith('shared/api/generated'))
      .filter(predicate)
  );
}

/**
 * Source with comments removed.
 *
 * The scanners count PATTERNS IN CODE, and prose about a rule is not a violation of it: a comment
 * explaining "use `Button`, not a bare `<button>`" was itself counted as a raw button, and a comment
 * naming `fixed inset-0 z-50` would count as a hand-rolled modal. Both are the opposite of the thing
 * being measured — writing down why a rule exists must not cost a point against it.
 *
 * Deliberately naive (no string-literal awareness): a `//` inside a string would be over-stripped, which
 * can only ever make a count LOWER on a file whose real violations are still counted elsewhere in the
 * same sweep. The alternative is a parser, for a guardrail.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');
}

/**
 * Every `<button ...>` OPENING TAG in a source file, read to its real end.
 *
 * Not a regex. `/<button[\s\S]*?>/` stops at the first `>`, and JSX attributes are full of arrow
 * functions — so `onClick={() => close()}` ends the match before `className` is ever seen. This walks
 * forward from `<button`, tracking brace depth and quote state, and ends the tag at the `>` that is
 * actually the tag's own.
 */
function buttonTags(source: string): string[] {
  const tags: string[] = [];
  const opener = /<button\b/g;
  let match: RegExpExecArray | null;

  while ((match = opener.exec(source)) !== null) {
    let depth = 0;
    let quote: string | null = null;
    for (let i = match.index + match[0].length; i < source.length; i += 1) {
      const char = source[i];
      if (quote) {
        if (char === quote && source[i - 1] !== '\\') quote = null;
      } else if (char === '"' || char === "'" || char === '`') {
        quote = char;
      } else if (char === '{') {
        depth += 1;
      } else if (char === '}') {
        depth -= 1;
      } else if (char === '>' && depth === 0) {
        tags.push(source.slice(match.index, i + 1));
        break;
      }
    }
  }
  return tags;
}

/**
 * Whether a tag says anything about focus.
 *
 * Both spellings count: the Tailwind utilities, and `FOCUS_RING` — the exported constant that names the
 * same thing for controls which legitimately are not a `Button`. A case-sensitive search for `focus`
 * misses the constant, which is how two correctly-ringed controls read as violations.
 */
function hasFocusRule(tag: string): boolean {
  return tag.includes('focus') || tag.includes('FOCUS_RING');
}

const inConsumerLayers = (rel: string) =>
  /^(pages|features|entities|widgets)\//.test(rel) && rel.endsWith('.tsx');

function countMatches(predicate: (rel: string) => boolean, re: RegExp) {
  const byFile: Record<string, number> = {};
  let total = 0;
  for (const rel of files(predicate)) {
    const n = (stripComments(readFileSync(join(SRC, rel), 'utf8')).match(re) ?? []).length;
    if (n) {
      byFile[rel] = n;
      total += n;
    }
  }
  return { total, byFile };
}

function worst(byFile: Record<string, number>, k = 10): string {
  return Object.entries(byFile)
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
    .map(([f, n]) => `  ${n.toString().padStart(4)}  ${f}`)
    .join('\n');
}

function assertRatchet(label: string, total: number, max: number, byFile: Record<string, number>) {
  if (total > max) {
    throw new Error(
      `${label} rose to ${total} (baseline ${max}). Use the shared primitive instead of ` +
        `raising the baseline. Worst files:\n${worst(byFile)}`,
    );
  }
  expect(total).toBeLessThanOrEqual(max);
}

describe('FE consistency ratchets (only ever decrease)', () => {
  it('finds the source surface it claims to guard', () => {
    // A scanner that stops seeing files reports zero violations, which is indistinguishable
    // from a finished migration.
    expect(
      files(inConsumerLayers).length,
      'Found almost no consumer-layer files. The scanner is broken, not the pages.',
    ).toBeGreaterThanOrEqual(10);
  });

  it(`raw <button> in consumer layers <= ${MAX_RAW_BUTTON}`, () => {
    const { total, byFile } = countMatches(inConsumerLayers, /<button/g);
    assertRatchet('raw <button> count', total, MAX_RAW_BUTTON, byFile);
  });

  it(`inline style={{}} in consumer layers <= ${MAX_INLINE_STYLE}`, () => {
    const { total, byFile } = countMatches(inConsumerLayers, /style=\{\{/g);
    assertRatchet('inline style={{ count', total, MAX_INLINE_STYLE, byFile);
  });

  it(`arbitrary text-[…] app-wide <= ${MAX_ARBITRARY_TEXT}`, () => {
    const { total, byFile } = countMatches((f) => f.endsWith('.tsx'), /text-\[/g);
    assertRatchet('arbitrary text-[ count', total, MAX_ARBITRARY_TEXT, byFile);
  });

  it(`hand-rolled modal overlays <= ${MAX_HANDROLLED_MODAL}`, () => {
    // Counts files, not occurrences: a page with two inline modals is one file to convert.
    const byFile: Record<string, number> = {};
    let total = 0;
    for (const rel of files((f) => f.endsWith('.tsx'))) {
      if (rel.includes('shared/ui/')) continue; // Modal itself, and slide-over, legitimately own one.
      if (HANDROLLED_MODAL_EXEMPT.some((exempt) => rel.includes(exempt))) continue;
      const hits = (
        stripComments(readFileSync(join(SRC, rel), 'utf8')).match(/fixed inset-0 z-50/g) ?? []
      ).length;
      if (hits > 0) {
        byFile[rel] = hits;
        total += 1;
      }
    }
    assertRatchet('hand-rolled modal files', total, MAX_HANDROLLED_MODAL, byFile);
  });

  it(`invented failure messages <= ${MAX_INVENTED_ERROR_MESSAGE}`, () => {
    /*
     * A string literal as the FIRST argument. `toast.error(e.message)` and
     * `toast.error(apiErrorMessage(error, '…'))` both pass; only a bare sentence counts.
     *
     * ALSO `setErr`/`setError`, which this check used to miss entirely — it matched `toast.error` only,
     * so it read 0 while fifteen screens set a hard-coded sentence into form state instead. Those were
     * the worse half: a toast is glanceable and gone, and a form error is the sentence somebody reads
     * while deciding what to do next. Among them the Inbox's "Failed to process request. Please try
     * again." for a permanent refusal, and the RBAC screen's "Check the user ID" for what was really a
     * missing permission.
     *
     * A ratchet reading 0 while violations exist is worse than no ratchet, because it certifies the
     * thing it cannot see.
     *
     * BUT THE OBVIOUS WIDER PATTERN IS WRONG, and I tried it first: matching every
     * `setErr('Capitalised…')` flags CLIENT-SIDE VALIDATION, which is not this defect at all. "A reason
     * is required for rejection." is a sentence the form is entitled to invent, because no API was
     * asked. What is forbidden is inventing one when the API has already answered — so the shape
     * matched is a literal set INSIDE an error branch, which is exactly where the API's message was
     * available and discarded.
     */
    const { total, byFile } = countMatches(
      (f) => /\.tsx?$/.test(f),
      /(?:toast\.error\(['`]|if \(\s*(?:err|error)[\w.!\s|]*\)\s*\{[^{}]*?set(?:Err|Error)\(\s*['`"][A-Z])/g,
    );
    assertRatchet('invented failure message count', total, MAX_INVENTED_ERROR_MESSAGE, byFile);
  });

  it('reads the API’s message somewhere, so the check above is not passing over a desert', () => {
    /*
     * THE FLOOR. `apiErrorMessage` is what the check above pushes callers towards; if it stopped being
     * used the count would fall to zero for the wrong reason. Same shape as the `FormError` floor
     * below, and the same reason: a ratchet needs to know the corpus it is measuring still exists.
     */
    const { total } = countMatches((f) => /\.tsx?$/.test(f), /apiErrorMessage\(/g);
    expect(
      total,
      'nothing calls apiErrorMessage any more — the invented-message check proves nothing',
    ).toBeGreaterThan(20);
  });

  it(`form errors rendered without role="alert" <= ${MAX_UNANNOUNCED_FORM_ERROR}`, () => {
    // The exact shape that was everywhere: a danger-toned paragraph whose only child is an `error`
    // binding. `FormError` renders the same markup WITH the role, so a match here is a slot that
    // bypassed it rather than a styling choice.
    /*
     * ANY binding, not one whose name happens to contain "error". The pattern used to require
     * `error` in the identifier, so six real violations bound to `err` and `submitError` — including
     * the profile form and all three RBAC tabs — were invisible and this read 0.
     */
    const { total, byFile } = countMatches(
      (rel) => rel.endsWith('.tsx') && !rel.startsWith('shared/ui/'),
      /<p className="text-xs text-danger">\{[\w.]+\}<\/p>/g,
    );
    assertRatchet('unannounced form errors', total, MAX_UNANNOUNCED_FORM_ERROR, byFile);
  });

  it('renders form errors through the kit, so the announcement is not optional', () => {
    // The converse, and the floor: if `FormError` stops being used the check above passes trivially.
    const { total } = countMatches((rel) => rel.endsWith('.tsx'), /<FormError\s/g);
    expect(
      total,
      'FormError is no longer used anywhere — the check above proves nothing',
    ).toBeGreaterThan(50);
  });

  it(`hand-rolled panel state triples <= ${MAX_HANDROLLED_PANEL_STATE}`, () => {
    const { total, byFile } = countMatches(
      (rel) => rel.endsWith('.tsx') && !rel.startsWith('shared/ui/'),
      /\.isLoading && <p className="text-xs text-fg-subtle">/g,
    );
    assertRatchet('hand-rolled panel states', total, MAX_HANDROLLED_PANEL_STATE, byFile);
  });

  it('renders panel states through the kit, so the error branch is not optional', () => {
    // The floor. Without it the count above falls to zero by deleting panels rather than fixing them,
    // and the four that reported a failure as an absence would be free to come back.
    const { total } = countMatches((rel) => rel.endsWith('.tsx'), /<PanelState\s/g);
    expect(total, 'PanelState is no longer used — the count above proves nothing').toBeGreaterThan(
      8,
    );
  });

  it(`hand-rolled modal footers <= ${MAX_HANDROLLED_FORM_FOOTER}`, () => {
    // The footer's own layout class, which all nineteen copies shared verbatim. Matching the layout
    // rather than the buttons is what makes this specific: a `justify-end` row elsewhere on a page is
    // not a form footer, and `pt-1` on this exact row is what `FormActions` renders.
    const { total, byFile } = countMatches(
      (rel) => rel.endsWith('.tsx') && !rel.startsWith('shared/ui/'),
      /className="flex justify-end gap-2 pt-1"/g,
    );
    assertRatchet('hand-rolled modal footers', total, MAX_HANDROLLED_FORM_FOOTER, byFile);
  });

  it('submits through the kit, so no form invents its own button order', () => {
    // The floor. Cancel-then-submit is a convention, not a preference — a form that reverses it puts
    // the destructive button where the last one put Cancel.
    const { total } = countMatches((rel) => rel.endsWith('.tsx'), /<FormActions\s/g);
    expect(total, 'FormActions is no longer used — the count above proves nothing').toBeGreaterThan(
      30,
    );
  });

  it(`raw buttons with no focus rule <= ${MAX_UNFOCUSABLE_BUTTON}`, () => {
    const byFile: Record<string, number> = {};
    let total = 0;
    for (const rel of files(inConsumerLayers)) {
      const source = stripComments(readFileSync(join(SRC, rel), 'utf8'));
      const unfocusable = buttonTags(source).filter((tag) => !hasFocusRule(tag)).length;
      if (unfocusable) {
        byFile[rel] = unfocusable;
        total += unfocusable;
      }
    }
    assertRatchet('raw buttons with no focus rule', total, MAX_UNFOCUSABLE_BUTTON, byFile);
  });

  it('finds the buttons it claims to be checking', () => {
    // The floor for the walker itself. A tag matcher that silently stops finding tags reports a clean
    // sweep of nothing — and the previous version of this check was wrong in the other direction, so
    // both directions are now pinned: it must see the buttons, and it must read them whole.
    const found = files(inConsumerLayers).flatMap((rel) =>
      buttonTags(stripComments(readFileSync(join(SRC, rel), 'utf8'))),
    );
    expect(found.length, 'the tag walker sees no buttons at all').toBeGreaterThan(3);
    // At least one real tag contains an arrow function, which is what broke the regex version.
    expect(
      found.some((tag) => tag.includes('=>')),
      'no tag contains an arrow function — the walker is stopping early again',
    ).toBe(true);
  });

  it('builds its buttons on the kit, so the ring is not per-caller', () => {
    // The floor. Deleting buttons would satisfy the count above; what must stay true is that the shared
    // component is doing the work, and that it still carries a focus ring for them to inherit.
    const button = readFileSync(join(SRC, 'shared/ui/button.tsx'), 'utf8');
    expect(button, 'Button no longer has a focus ring — every caller just lost one').toContain(
      'focus-visible:ring',
    );

    const { total } = countMatches((rel) => rel.endsWith('.tsx'), /<(?:Button|IconAction)\s/g);
    expect(total, 'nothing uses the kit button — the count above proves nothing').toBeGreaterThan(
      60,
    );
  });

  it(`inline cache windows <= ${MAX_INLINE_CACHE_WINDOW}`, () => {
    // A numeric literal on either option. `staleTime: STALE.REPORT` does not match; `staleTime: 300_000`
    // and `staleTime: 5 * 60_000` both do.
    const { total, byFile } = countMatches(
      (rel) => /\.tsx?$/.test(rel) && rel !== 'shared/api/cache.ts',
      /(?:staleTime|refetchInterval):\s*[\d_]/g,
    );
    assertRatchet('inline cache windows', total, MAX_INLINE_CACHE_WINDOW, byFile);
  });

  it('names its cache tiers, so the count above is not zero by deletion', () => {
    // The floor. Deleting every `staleTime` would satisfy the check above and quietly put half the SPA
    // back on refetch-per-mount.
    const { total } = countMatches((rel) => /\.tsx?$/.test(rel), /\b(?:STALE|POLL)\.[A-Z]/g);
    expect(
      total,
      'nothing uses a named cache tier — the count above proves nothing',
    ).toBeGreaterThan(25);
  });

  it(`inline em dashes <= ${MAX_INLINE_EM_DASH}`, () => {
    const { total, byFile } = countMatches(
      (rel) => /\.tsx?$/.test(rel) && rel !== 'shared/lib/format.ts',
      /'—'/g,
    );
    assertRatchet('inline em dashes', total, MAX_INLINE_EM_DASH, byFile);
  });

  it(`call-site date formatting <= ${MAX_INLINE_DATE_FORMAT}`, () => {
    /*
     * `toLocaleDateString` / `toLocaleTimeString` / `toLocaleString` anywhere but `format.ts`. Matching
     * the API rather than the locale string is what catches both drifts: one passed the WRONG locale
     * and one passed NO locale, and a scanner looking for `'en-US'` would have missed the second.
     */
    const { total, byFile } = countMatches(
      (rel) => /\.tsx?$/.test(rel) && rel !== 'shared/lib/format.ts',
      /\.toLocale(?:Date|Time)?String\(/g,
    );
    assertRatchet('call-site date formatting', total, MAX_INLINE_DATE_FORMAT, byFile);
  });

  it('formats dates through the kit, so there is one opinion about a moment', () => {
    // The floor for the check above: with no formatter in use, "no inline formatting" is trivially true.
    const { total } = countMatches(
      (rel) => /\.tsx?$/.test(rel),
      /\bformat(?:Date|DateTime|Time|TimeUntil)\(/g,
    );
    expect(total, 'nothing formats a date through format.ts').toBeGreaterThan(40);
  });

  it(`every source file <= ${MAX_FILE_LINES} lines`, () => {
    /*
     * EVERY offender, not the largest one.
     *
     * This used to sort by size and report only the top file, which hid the rest — so decomposing the
     * one it named revealed the next, and the next. Three separate rounds of that happened in one
     * afternoon, and worse, an agent working on a different page could not tell that its own file was
     * over the line because somebody else's was bigger. A ratchet that reports one of N failures
     * teaches the reader that fixing it is the end of the job.
     */
    const over = files(() => true)
      .map((rel) => [rel, readFileSync(join(SRC, rel), 'utf8').split('\n').length] as const)
      .filter(([, lines]) => lines > MAX_FILE_LINES)
      .sort((a, b) => b[1] - a[1]);

    if (over.length > 0) {
      throw new Error(
        `${over.length} file(s) over the ${MAX_FILE_LINES}-line ceiling. Decompose them rather than ` +
          `raising it — pages are composition, one component per file:\n` +
          over.map(([rel, lines]) => `  ${lines}  ${rel}`).join('\n'),
      );
    }
    expect(over).toEqual([]);
  });
});
