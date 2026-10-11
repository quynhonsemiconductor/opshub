import { Link } from '@tanstack/react-router';
import { ArrowRight, Construction } from 'lucide-react';

interface PlaceholderPageProps {
  title: string;
  description: string;
}

export function PlaceholderPage({ title, description }: PlaceholderPageProps) {
  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-lg font-semibold tracking-tight text-fg">{title}</h1>
        <p className="mt-0.5 text-sm text-fg-muted">{description}</p>
      </div>

      <div className="flex flex-col items-center justify-center rounded-lg border border-border border-dashed bg-surface px-6 py-16 text-center">
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-surface-muted">
          <Construction className="h-5 w-5 text-fg-subtle" strokeWidth={1.75} />
        </div>
        <h2 className="text-sm font-medium text-fg-muted">Coming soon</h2>
        <p className="mt-1.5 max-w-sm text-sm text-fg-subtle">
          This module is scaffolded and ready for implementation. Connect it to the API using{' '}
          <code className="rounded bg-surface-muted px-1.5 py-0.5 text-xs font-mono text-fg-muted">
            shared/api/client
          </code>
          .
        </p>
        <Link
          to="/"
          className="mt-6 flex items-center gap-1.5 text-xs font-medium text-accent hover:text-accent"
        >
          Back to overview
          <ArrowRight className="h-3.5 w-3.5" strokeWidth={1.75} />
        </Link>
      </div>
    </div>
  );
}
