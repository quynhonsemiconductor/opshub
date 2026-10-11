import { Lock, ExternalLink } from 'lucide-react';

interface UpgradeGateProps {
  feature: string;
  requiredLicense: string;
  description: string;
  learnMoreHref?: string;
}

export function UpgradeGate({
  feature,
  requiredLicense,
  description,
  learnMoreHref,
}: UpgradeGateProps) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border bg-surface px-8 py-16 text-center">
      <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-surface-muted">
        <Lock className="h-6 w-6 text-fg-muted" />
      </div>

      <h3 className="text-base font-semibold text-fg">{feature}</h3>
      <p className="mt-1 text-sm text-fg-muted">{description}</p>

      <div className="mt-5 rounded-lg border border-border bg-surface-muted px-4 py-3 text-left">
        <p className="text-xs font-medium text-fg-muted uppercase tracking-wide">
          Required license
        </p>
        <p className="mt-0.5 text-sm font-medium text-fg">{requiredLicense}</p>
      </div>

      <p className="mt-4 text-xs text-fg-muted">
        Contact your Microsoft admin to upgrade, or ask your IT team to enable this feature.
      </p>

      {learnMoreHref && (
        <a
          href={learnMoreHref}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-3 inline-flex items-center gap-1.5 text-xs text-accent hover:underline"
        >
          Learn more
          <ExternalLink className="h-3 w-3" />
        </a>
      )}
    </div>
  );
}
