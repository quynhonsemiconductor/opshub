import { useEffect, useId, useRef, useState } from 'react';
import { useDebounced } from '@/shared/hooks/use-debounced';
import { useQuery } from '@tanstack/react-query';
import { Check, ChevronDown, Loader2, Search, X } from 'lucide-react';
import { cn } from '@/shared/lib/utils';

/**
 * EntityPicker — choose a record by NAME, when the API wants its id.
 *
 * WHY THIS EXISTS. Four forms in the SPA asked the user to type a UUID into a text box with the
 * placeholder "UUID": draft a contract, assign somebody to a position, and now record a completed
 * course. Nobody knows an employee's UUID. The only way to fill those fields was to open another
 * screen, click a row, and copy the id out of the URL — so the forms worked in a demo and not in use.
 *
 * A native `<select>` is the right primitive when the options are a fixed vocabulary, which is why
 * `Select` stays exactly as it is. It is the wrong one for a directory: two thousand employees in one
 * `<option>` list is a page-weight problem and a scrolling problem, and it cannot be searched
 * server-side. This is the async case, and the only one.
 *
 * ACCESSIBILITY IS THE REASON THIS IS NOT DIVS WITH A CLICK HANDLER. It implements the combobox
 * pattern the way assistive tech expects: `role="combobox"` with `aria-expanded` and `aria-controls`,
 * a `role="listbox"` of `role="option"`s, `aria-activedescendant` so the reader announces the row the
 * arrow keys are on WITHOUT moving focus out of the input, arrow/Enter/Escape, and a click-outside
 * that closes rather than trapping. That is also what makes it testable by role.
 */

export interface PickerOption {
  value: string;
  label: string;
  /** Secondary line — a department, a course code. Shown dimmer, never the only identifier. */
  hint?: string;
}

export interface EntityPickerProps {
  /** The selected id, or `''` for nothing chosen. */
  value: string;
  /**
   * The chosen id, and the option it came from.
   *
   * The second argument exists because the picker is the only thing that knows the LABEL — a caller that
   * wants to say "Require a course for Senior Engineer" would otherwise have to fetch the position again
   * to learn its title. Absent when the selection is cleared.
   */
  onChange: (value: string, option?: PickerOption) => void;
  /**
   * Fetch the options for a search term. Called with `''` when the list first opens, so the picker
   * shows something before anybody types.
   */
  fetchOptions: (term: string) => Promise<PickerOption[]>;
  /** Distinguishes this picker's cache from another's. Use the entity name: `employees`, `courses`. */
  queryKey: string;
  /**
   * The label for the CURRENT value, when the caller knows it.
   *
   * Without this a picker rendered with a pre-set value can only show the raw id — the label lives in
   * a response the picker has not fetched. Editing an existing record is exactly that case.
   */
  selectedLabel?: string;
  id?: string;
  /**
   * The accessible name, for a picker with no visible `<label>` — a filter in a toolbar.
   *
   * Required in that position rather than optional-in-practice: a combobox whose only description is a
   * placeholder is announced as "edit text, blank" by a screen reader, and cannot be located by name
   * from a test either. Inside a `FormField`, leave this out: the label already names it.
   */
  ariaLabel?: string;
  placeholder?: string;
  disabled?: boolean;
  /** Shown when a search returns nothing, so an empty list is never silent. */
  emptyMessage?: string;
}

export function EntityPicker({
  value,
  onChange,
  fetchOptions,
  queryKey,
  selectedLabel,
  id,
  ariaLabel,
  placeholder = 'Search…',
  disabled = false,
  emptyMessage = 'No matches',
}: EntityPickerProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const listboxId = `${inputId}-listbox`;

  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState('');
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);

  /**
   * The option this picker chose, remembered so the field shows a NAME the moment it is picked rather
   * than after a refetch.
   *
   * DERIVED, not synchronised. An effect copying `selectedLabel` into state would be the cascading-render
   * anti-pattern eslint rejects, and worse, it would go stale: the remembered option is used only while
   * it still describes the current `value`, so a caller that changes `value` from outside wins
   * automatically instead of being overwritten by a memory of an older choice.
   */
  const [picked, setPicked] = useState<PickerOption | null>(null);
  const chosenLabel =
    picked && picked.value === value ? picked.label : value ? (selectedLabel ?? value) : '';

  // Debounced, because every keystroke is a request otherwise — and a directory search is not free.
  // The implementation is shared with the command palette, which searches the same endpoints.
  const debounced = useDebounced(term);

  const options = useQuery({
    queryKey: ['entity-picker', queryKey, debounced],
    queryFn: () => fetchOptions(debounced),
    // Only while the list is open: a form with four pickers must not fire four searches on mount.
    enabled: open,
  });

  const rows = options.data ?? [];

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  function choose(option: PickerOption) {
    onChange(option.value, option);
    setPicked(option);
    setTerm('');
    setOpen(false);
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      setActive((current) => Math.min(Math.max(current + delta, 0), Math.max(rows.length - 1, 0)));
      return;
    }
    if (event.key === 'Enter' && open && rows[active]) {
      event.preventDefault();
      choose(rows[active]);
      return;
    }
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      setOpen(false);
    }
  }

  return (
    <div ref={rootRef} className="relative">
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-subtle"
          strokeWidth={1.75}
          aria-hidden="true"
        />
        <input
          id={inputId}
          type="text"
          role="combobox"
          aria-label={ariaLabel}
          aria-expanded={open}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={open && rows[active] ? `${listboxId}-${active}` : undefined}
          autoComplete="off"
          disabled={disabled}
          // Shows the CHOSEN name while closed and the search term while typing, so the field always
          // says what is selected instead of clearing itself the moment it loses focus.
          value={open ? term : chosenLabel}
          placeholder={value && !open ? chosenLabel || value : placeholder}
          onFocus={() => setOpen(true)}
          onChange={(event) => {
            setTerm(event.target.value);
            setActive(0);
            setOpen(true);
          }}
          onKeyDown={onKeyDown}
          className={cn(
            'h-9 w-full rounded-md border border-border bg-surface pl-8 pr-14 text-sm text-fg placeholder:text-fg-subtle transition-colors focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20 disabled:cursor-not-allowed disabled:opacity-50',
          )}
        />
        <div className="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-0.5">
          {value && !disabled && (
            <button
              type="button"
              aria-label="Clear selection"
              onClick={() => {
                onChange('');
                setPicked(null);
                setTerm('');
              }}
              className="rounded p-1 text-fg-subtle transition-colors hover:text-danger"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
          {options.isFetching ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-fg-subtle" aria-hidden="true" />
          ) : (
            <ChevronDown className="h-4 w-4 text-fg-subtle" strokeWidth={1.75} aria-hidden="true" />
          )}
        </div>
      </div>

      {open && (
        <ul
          id={listboxId}
          role="listbox"
          className="absolute z-20 mt-1 max-h-60 w-full animate-fade-up overflow-y-auto rounded-md border border-border bg-surface py-1 shadow-lg"
        >
          {options.isLoading && <li className="px-3 py-2 text-xs text-fg-subtle">Searching…</li>}
          {options.isError && (
            <li className="px-3 py-2 text-xs text-danger">Could not load the list.</li>
          )}
          {!options.isLoading && !options.isError && rows.length === 0 && (
            <li className="px-3 py-2 text-xs text-fg-subtle">{emptyMessage}</li>
          )}
          {rows.map((option, index) => (
            <li
              key={option.value}
              id={`${listboxId}-${index}`}
              role="option"
              aria-selected={option.value === value}
            >
              <button
                type="button"
                // `onMouseDown`, not `onClick`: the pointerdown listener above closes the list first,
                // and a click that lands after the unmount never reaches the handler.
                onMouseDown={(event) => {
                  event.preventDefault();
                  choose(option);
                }}
                onMouseEnter={() => setActive(index)}
                className={cn(
                  'flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors',
                  index === active ? 'bg-surface-muted text-fg' : 'text-fg-muted',
                )}
              >
                <Check
                  className={cn(
                    'h-3.5 w-3.5 shrink-0',
                    option.value === value ? 'text-accent' : 'invisible',
                  )}
                />
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
                {option.hint && (
                  <span className="shrink-0 truncate text-xs text-fg-subtle">{option.hint}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
