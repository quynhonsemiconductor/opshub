import type { ReactNode, LabelHTMLAttributes } from 'react';
import { cn } from '@/shared/lib/utils';

// ── FormField ─────────────────────────────────────────────────────────────────

interface FormFieldProps {
  label: string;
  htmlFor?: string;
  error?: string;
  hint?: string;
  required?: boolean;
  className?: string;
  children: ReactNode;
}

/**
 * Enterprise-grade form field wrapper.
 * Renders label + input slot + inline error with full aria wiring.
 */
export function FormField({
  label,
  htmlFor,
  error,
  hint,
  required,
  className,
  children,
}: FormFieldProps) {
  const errorId = error && htmlFor ? `${htmlFor}-error` : undefined;
  const hintId = hint && htmlFor ? `${htmlFor}-hint` : undefined;

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={htmlFor} className="text-xs font-medium text-fg-muted">
        {label}
        {required && (
          <span className="ml-0.5 text-danger" aria-hidden="true">
            *
          </span>
        )}
      </label>

      {hint && (
        <p id={hintId} className="text-xs text-fg-subtle">
          {hint}
        </p>
      )}

      {children}

      {error && (
        <p id={errorId} role="alert" className="flex items-center gap-1 text-xs text-danger">
          <span aria-hidden="true">✕</span>
          {error}
        </p>
      )}
    </div>
  );
}

// ── Label-only helper ─────────────────────────────────────────────────────────

interface FieldLabelProps extends LabelHTMLAttributes<HTMLLabelElement> {
  required?: boolean;
}

export function FieldLabel({ children, required, className, ...props }: FieldLabelProps) {
  return (
    <label className={cn('text-xs font-medium text-fg-muted', className)} {...props}>
      {children}
      {required && (
        <span className="ml-0.5 text-danger" aria-hidden="true">
          *
        </span>
      )}
    </label>
  );
}

// ── FieldError ────────────────────────────────────────────────────────────────

export function FieldError({ id, message }: { id?: string; message: string | undefined }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="flex items-center gap-1 text-xs text-danger">
      <span aria-hidden="true">✕</span>
      {message}
    </p>
  );
}
