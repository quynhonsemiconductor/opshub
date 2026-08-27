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
