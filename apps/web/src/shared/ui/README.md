# The OpsHub UI kit

Import from `@/shared/ui`. One path, so a primitive cannot be missed by somebody who did not know
which file it was in — which is exactly how ten screens ended up hand-rolling a dialog while
`Modal` sat here unused.

## The rules

**1. A list screen is `ListPage` + `DataTable` + `PaginationFooter` + `useListState`.**
Never a bare `<table>`, and never a list of clickable `<div>`s. `DataTable` owns loading, error, empty
and the `colSpan`; the page owns the columns and the query. Every list endpoint pages server-side, so
`useListState` holds the offset and resets it when the search or a filter changes.

A clickable row is focusable and answers Enter/Space, but it is **not** `role="button"` — a button's
accessible name is computed from its contents, so the row swallowed every cell's text and collided
with the buttons inside it. Find a row by its text, and the controls in it by name.

**Bulk selection is opt-in and caller-owned.** Pass `onSelectionChange` plus `selectedIds`
(`Set<string>` or `string[]`) and a leading checkbox column appears — pass neither and the table is
exactly what it always was, so no existing page changes a line. Row identity is the table's own
`rowKey` (default `row.id`). The component holds no selection state: it fires back the complete id
array plus its size, so the caller's update is one `setState` of a plain replacement. Select-all is
scoped to the CURRENT page and never touches ids from other pages, and selections survive paging by
construction — nothing in the table clears them, because nothing in it knows what a page turn means
to the caller's query. `bulkActions={(n) => …}` renders a slim bar above the table only while the
selection is non-empty, and `n` is the count for its label ("3 selected").

**2. A status is a TONE, never a class string.**
`<StatusBadge tone={statusTone(x)}>{humanizeStatus(x)}</StatusBadge>`. `statusTone` says what a word
means, `Badge` says what a tone looks like. Raw Tailwind pairs (`bg-orange-50 text-orange-700`) do
not flip in dark mode — one screen had that and was unreadable on a dark background.
A vocabulary used on **one** screen keeps its map in that screen; two or more screens means it
belongs in `status-tone.ts`.

**3. A dialog is `Modal`. A drawer is `SlideOver`. A confirmation is `ConfirmDialog`.**
`Modal` has `role="dialog"`, a focus trap, Escape, scroll lock and focus restore. A hand-rolled
`fixed inset-0` has none of those, and the ten that existed let keyboard users tab into the page
behind them.

In a test: `Modal` and `SlideOver` are `role="dialog"`; `ConfirmDialog` is **`role="alertdialog"`**,
which is correct for a destructive confirmation and is not matched by `getByRole('dialog')`. Close a
drawer with its own **Close panel** button rather than Escape — Escape is handled on the panel, so it
only fires while focus is inside it.

**4. Form controls are `FormField` + `Input` / `Textarea` / `Select`.**
`FormField` wires the label, the hint and `aria-describedby`; the controls wire `aria-invalid`.
`Select` is a **native** `<select>` — the platform already gives keyboard support, type-ahead and
the right picker on a phone.

**5. One choice from a small set is `SegmentedControl`; a section switch is `Tabs` + `TabPanel`.**
Both are real ARIA widgets with arrow-key navigation and a roving tab index. A row of buttons is
not either of them.

**6. Label/value pairs are `DescriptionList`; a record drawer is `EntityDetailPanel`.**
`DescriptionList` renders `dl`/`dt`/`dd` and the em dash for absent values, so no page writes
`?? '—'` again. `EntityDetailPanel` fixes the drawer's section ORDER — what this is, what is
special about it, what happened to it — and omits the Activity section entirely for a record type
with no audit trail.

**7. Never hand-write a response type; never call `fetch` directly.**
`@/shared/api/client` is generated from the OpenAPI spec. The finops screen declared its own
`SoftwareLicense`/`PagedResult` interfaces "until openapi-typescript regenerated" — and they drifted:
`total` sat at the top level where the API puts it in `pageInfo`, so a stat tile read 0 forever and
the pager never rendered. Generated types would not have compiled.

**8. Dates and numbers go through `@/shared/lib/format`.**
`formatDate` treats a `YYYY-MM-DD` as the calendar date it is — `new Date('2026-03-04')` is UTC
midnight and renders as the 3rd for anyone behind UTC. `formatDecimal` handles the strings the
`numeric` columns arrive as.

**9. KPI tiles are `StatCard` inside `StatGrid`.**
It owns the loading skeleton and the `alert` treatment (a red ring, and only when the number is
above zero — a red ring round a zero is an alarm about nothing). A tile that navigates wraps it in a
`Link`; the kit stays router-free.

**10. A screen whose only difference between variants is WHICH widgets it lists should list them as
data.** The dashboard was seven components and ~500 lines of near-identical JSX; it is now one
`personas.ts` table, and the drift it was hiding — the same destination described three ways, an
alert flag on four of five identical tiles — had nowhere left to live.

**11. An action the caller may not take is WITHHELD, and where the reason varies per row, say it.**
A control gated on nothing is a permanent 403 rendered as "please try again" — twelve tab files
offered New role, Assign, Verify, Retire and Approve to anyone who could read the screen. Read the
permission off the route's own `@RequirePermission`, not from memory, and check it with
`usePermissions().can(...)`; `test/fe-permission-contract.spec.ts` fails the build on a code that is
not in the catalogue. A route marked `@SelfScoped` needs **no** gate — logging your own shift and
withdrawing your own leave are the only actions an employee holding nothing can take, and gating
them removes the screen's whole point for them.

Withhold silently when the answer is one tenant-wide fact about the reader — a note repeated on
every row tells nobody anything the empty column does not. Use `DecisionNote` when it varies per
row: "Yours — a colleague decides" and "Not yours to decide" are different next actions, and the
sentences live in `decision-reason.ts` keyed on the request engine's own `viewerCannotDecideReason`
so the inbox and the workforce tabs cannot drift into two phrasings of one rule.

And check the EMPTY STATE with the button: "Add your first license to start tracking seats and cost"
next to a withheld Add button is the same false instruction in slower words.

**12. Supportive guidance on a control is `Tooltip`. It is never the native `title`, and it is never
where a LABEL or a HINT belongs.**
`title` was the only tooltip this kit had, and **26 places** used it — it is invisible on a touch
device, unstyleable, about a second slow, and read out or not depending on whose screen reader it is.
Worse, almost all 26 restate the verb already in the `aria-label` beside them: `aria-label={`Retire
${control.title}`} title="Retire"`, in eleven files. That is a slow duplicate of the NAME and no
description at all, which is the one thing a tooltip is for. `Tooltip` opens on **focus** as well as
hover — with no delay on focus, because `aria-describedby` only points at the bubble while the bubble
exists, so a delay there does not make the announcement late, it removes it — and Escape dismisses it,
per WCAG 1.4.13. Escape is taken in the CAPTURE phase and stopped there, so a tooltip open inside a
`Modal` does not answer one keypress twice.

Two sites are converted and **24 remain**, including `IconAction`'s own `title={label}`, which is
every icon action in the product. Most of those want the attribute simply DELETED rather than replaced:
a duplicate of the accessible name is not guidance, and there is nothing to move into a bubble.

Reach for it when the control is already named and the reader still has to GUESS a consequence: what
"Sync now" syncs and in which direction, that removing a goal blocks the review it belongs to, that
"No DPA" is a GDPR Article 28(3) gap and that the badge is the way to close it. Those are the three
adoptions; there are deliberately not thirty.

**When it is the WRONG answer.** A sentence that is always relevant is a `FormField` hint or a
`StatCard` hint — visible, no interaction, and no one has to find it. A derivation short enough to
print should be printed: `11 / 16 checks` beats a tooltip on `69%`, and a bare number is not focusable
anyway, so a tooltip on one is mouse-only help. Truncated content is not a tooltip either — the
`title={r.reviewNote}` and `title={r.notes}` spans on the access and software-catalog screens want a
wider column or the drawer, because a tooltip cannot be selected, copied or reached by touch. And
nothing that must be read to complete a task goes in here at all.

It renders **in place, not through a portal**: inside a `Modal` or a `SlideOver` the bubble is above
the panel because it is INSIDE its stacking context, so there is no z-index to keep in agreement with
`OVERLAY_LAYER`. The cost is clipping by an `overflow-hidden` panel or a `DataTable`'s
`overflow-x-auto`; `placement="bottom"` is the escape hatch, and a tooltip that needs to break out of
a scroll box to be legible was probably a column.

**13. Motion is a TOKEN in `globals.css`, never a class name borrowed from a plugin.**
`Modal`, `ConfirmDialog`, the command palette and `Tooltip` all carried `animate-in fade-in-0
zoom-in-95 duration-150`. That is `tailwindcss-animate` vocabulary, the plugin is not a dependency,
and there were no `@keyframes` in the repo — so four surfaces generated NO CSS and every dialog in
the product appeared instantly. `duration-150` is the tell: it compiles, but to
`transition-duration`, which an animation never reads. Nothing about the class string looked wrong,
which is why it survived review; only the stylesheet was wrong.

Tailwind v4 needs no plugin. An `--animate-<name>` token plus its `@keyframes` IS the mechanism, and
it generates the `animate-<name>` utility. Name the token after the SURFACE, not the property —
`animate-dialog-in`, `animate-tooltip-in` — so the timing and easing live in one place and a call
site cannot half-specify them the way four classes did. Reuse an existing token before adding one; a
second token needs a reason a reader can see (the tooltip fades and does not scale, because a bubble
growing beside the cursor reads as arrival rather than explanation).

**Reduced motion is handled once, at the token.** Every `--animate-*` is set to `none` inside
`@media (prefers-reduced-motion: reduce)` in `globals.css`, which is why the tokens sit in a plain
`@theme` and not `@theme inline`: `inline` bakes the value into the utility and leaves nothing to
override. A `motion-reduce:` variant at a call site is a second opinion about a rule the sheet
already owns. A zooming dialog can trigger vestibular symptoms, so this is not a preference.

`app/styles/motion.spec.ts` compiles `globals.css` with Tailwind itself and fails on any animation
class in `src/` that produces no rule, on a token whose `@keyframes` nothing defines, and on a new
token with no reduced-motion override. It runs in **node**, not jsdom: jsdom implements neither
`@media` matching nor `@keyframes`, so this is not assertable from a rendered component — and an
assertion on `className` would have passed against the bug it exists for.

**14. A date window is `DateRangePicker`. A length of time is `DurationInput`.**
A pair of `type="date"` inputs is not a range picker: each opens its own platform calendar, nothing
orders them, and "to before from" reaches the API as a 422 — or worse, as data. `DateRangePicker`
emits an ORDERED `{ from, to }` of `YYYY-MM-DD` or `null`, and the ordering rule is **auto-swap,
not an error**: a second pick before the first meant "back to that Monday", so the pair is emitted
ordered and the field being typed into keeps its draft until blur. Nothing is committed until both
ends are complete and real (Feb 31 fails a parse round-trip, not a regex) — a caller never stores a
half-typed date. The calendar is one `role="dialog"` grid under both fields, arrow/Page keys move
the roving focus, Escape closes onto the field that opened it, and a `YYYY-MM-DD` is parsed and
printed BY PARTS — `new Date('2026-03-04')` is UTC midnight, the exact bug `format.ts` exists for.

`DurationInput` holds MINUTES — the unit the API stores — and shows hours + minutes, because "90"
beside a "Duration" label reads as ninety minutes to half the room and 1h30 to the rest, and the
split fields settle it. `onChange` fires with minutes **or not at all**: typing that does not parse
or breaks `min`/`max` is HELD in the field, flagged `aria-invalid`, and explained by a
`role="alert"` line — never clamped, because a control that quietly rewrites "90" into "1" while
somebody is typing teaches them the field lies. Presets (`{ label: '4h', minutes: 240 }`) are
`aria-pressed` buttons; `formatDuration` in `@/shared/lib/format` is the one spelling of a length,
so a hint and an error cannot disagree.

Neither one opens a dependency. No date or duration library was installed, and two components are
not the price of admission for one — the calendar grid is ninety lines of local `Date` arithmetic,
which is also the only way it stays timezone-honest by parts.

## Testing a screen from the browser

Three rules, each learned by a failing run rather than guessed:

1. **Create the data you assert on.** The seed does not populate the software catalogue or the service
   catalog, and "the first row" is whatever a previous run left behind. Two specs failed in CI for
   this before the rule was written down.
2. **Wait for the table to settle before clicking a row.** `tbody tr` also matches the loading, error
   and empty rows, which have no click handler — `clickFirstRow()` in `e2e/support/fixtures.ts` waits
   for a real data row. Racing it failed about one run in three.
3. **Make "unique" actually unique.** A window derived from `Date.now() % 3000` repeats every fifty
   minutes, so an afternoon of runs collided with itself.

## Testing

Component specs live beside the component as `*.spec.tsx` with `// @vitest-environment jsdom` at the
top — **not** a config glob, because Vitest 4 removed `environmentMatchGlobs`. Assert on roles and
behaviour, not classes: a Tailwind change must not fail a test, and a missing `role` must not pass
one.

## Composition

A page file COMPOSES; it does not also contain the forms, tables and drawers. `fe-consistency.
ratchet.test.ts` enforces a line ceiling and it has already earned it: the workforce conversion
produced one 1272-line file and the ratchet refused it. That screen is now six modules —
`workforce-page.tsx` (61 lines) plus a module per tab — and the largest is 343.

Helpers live in their own module, not beside components: eslint's
`react-refresh/only-export-components` is right that mixing them breaks Fast Refresh for the file.

## Conversion status

**Every screen is converted.** `compliance`, `access`, `workforce`, `people`, `settings/rbac`,
`dashboard`, `finops`, `assets`, `requests`, `catalog`, `profile`, `settings/webhooks`,
`settings/audit-logs`, `security-posture`, `reports`.

The hand-rolled-dialog ratchet is now a **floor at 0**: every dialog goes through `Modal`, and any new
`fixed inset-0 z-50` fails the build. The command palette is exempted **by name**, because it is a
combobox surface rather than a titled dialog and implements its own pattern — a baseline of 1 would
have silently absorbed the next real violation instead.

Where the ratchets ended up: raw `<button>` **149 → 45** (the rest are inside `shared/ui`, where a
button IS the primitive, plus icon actions carrying their own `aria-label`), hand-rolled modal files
**11 → 0**, largest file **1082 → 497**, arbitrary `text-[…]` 29 → 26. Lower them by converting, never
by editing the number.

**Charts take CSS variables, not hex.** `fill="var(--color-info)"` works in SVG exactly as it does in
Tailwind. The six hex literals finops used were the light palette baked in, so every slice kept its
light-mode colour on a dark background.

**A selectable card is a real `<input>`.** The people wizard's device cards and access list were
`<button>`s with a colour for "selected" — no group, no checked state, nothing announced. They are
now `sr-only` radio/checkbox inputs inside styled labels, so the platform supplies the semantics and
the keyboard while the card keeps its look. In a test, click the LABEL: an `sr-only` input has no
clickable box and Playwright's `check()` waits forever for one.

Convert a screen when you touch it, and keep this list honest.
