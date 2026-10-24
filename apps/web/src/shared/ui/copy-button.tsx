import { useState } from 'react';
import { Check, Copy } from 'lucide-react';

/**
 * CopyButton — the "copy a credential" button, in ONE shape.
 *
 * Written for the door terminal's show-once token (ADR ATTENDANCE-DEVICE §2.3): the token is only
 * ever displayed inside a dialog, and "select the text yourself" is not a safe instruction when
 * the alternative is re-provisioning hardware. Feedback is check-then-revert; the clipboard write
 * is attempted with the async API and silently reported, never thrown past the dialog.
 */
export function CopyButton(props: { text: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(props.text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard denied (permissions, insecure context): leave the text selectable — it IS the
      // fallback, which is why the code renders as text and not as dots.
    }
  }

  return (
    <button
      type="button"
      onClick={() => void copy()}
      aria-label={props.label ?? 'Copy'}
      title={props.label ?? 'Copy'}
      className={
        props.className ??
        'shrink-0 rounded border border-border p-2 text-fg-muted hover:bg-surface-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40'
      }
    >
      {copied ? <Check className="size-4 text-green-600" /> : <Copy className="size-4" />}
    </button>
  );
}
