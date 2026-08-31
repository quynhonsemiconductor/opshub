/** Small internal pieces `DateRangePicker` composes from — split out to keep that file readable. */
import type { InputHTMLAttributes, ReactNode, Ref } from 'react';
import { cn } from '@/shared/lib/utils';
import { FOCUS_RING } from './button';

/** One end of the range. Identical twins by design — see `Select`'s "styled to match `Input`" note. */
export interface RangeFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  ref?: Ref<HTMLInputElement>;
  invalid: boolean;
  onEdit: (text: string) => void;
}

export function RangeField({ invalid, onEdit, className, ...rest }: RangeFieldProps) {
  return (
    <input
      type="text"
      inputMode="numeric"
      autoComplete="off"
      placeholder="yyyy-mm-dd"
      {...rest}
      onChange={(e) => onEdit(e.target.value)}
      aria-invalid={invalid || undefined}
      className={cn(
        'h-9 w-full rounded-md border bg-surface pl-8 pr-2 text-sm text-fg placeholder:text-fg-subtle transition-colors focus:outline-none focus:ring-2 disabled:cursor-not-allowed disabled:opacity-50',
        invalid
          ? 'border-danger focus:border-danger focus:ring-danger/20'
          : 'border-border focus:border-accent focus:ring-accent/20',
        className,
      )}
    />
  );
}

/** A month chevron. Two of these differed by nothing but direction, so they are one component. */
export function MonthButton(props: {
  label: string;
  blocked: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={props.label}
      disabled={props.blocked}
      onClick={props.onClick}
      className={cn(
        'rounded-md p-1 text-fg-muted transition-colors hover:bg-surface-hover hover:text-fg disabled:pointer-events-none disabled:opacity-40',
        FOCUS_RING,
      )}
    >
      {props.children}
    </button>
  );
}
