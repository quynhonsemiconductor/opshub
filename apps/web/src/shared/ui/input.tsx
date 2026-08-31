import type { InputHTMLAttributes } from 'react';
import { cn } from '@/shared/lib/utils';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  error?: string;
}

export function Input({ className, error, id, ...props }: InputProps) {
  const errorId = error && id ? `${id}-error` : undefined;
  return (
    <input
      id={id}
      aria-invalid={error ? 'true' : undefined}
      aria-describedby={errorId}
      className={cn(
        'h-9 w-full rounded-md border bg-surface px-3 text-sm text-fg placeholder:text-fg-subtle transition-colors focus:outline-none focus:ring-2 disabled:cursor-not-allowed disabled:opacity-50',
        error
          ? 'border-danger focus:border-danger focus:ring-danger/20'
          : 'border-border focus:border-accent focus:ring-accent/20',
        className,
      )}
      {...props}
    />
  );
}
