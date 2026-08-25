import { useState } from 'react';
import {
  AlertTriangle,
  CheckCircle,
  Eye,
  EyeOff,
  ShieldAlert,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import { Button, StatusBadge, humanizeStatus, statusTone } from '@/shared/ui';
import { orDash } from '@/shared/lib/format';
import type { BaselineCheck } from './security-posture-page';

/**
 * The baseline drift table, its show/hide toggle, and the verdict on the whole set.
 *
 * EXTRACTED, not rewritten. The page reached the 486-line ceiling the FE consistency ratchet holds,
 * and that ratchet's message is the right instruction: a page is composition, and a hundred-line table
 * literal is a component. Nothing about the rows changed in the move.
 *
 * The one thing that DID change, and the reason this file exists at all: the green all-clear now
 * requires the query to have SUCCEEDED and to have returned checks. It used to be conditioned on "no
 * failing check in the array", and an errored request leaves that array empty — so a dropped fetch
 * rendered a security attestation. Zero checks is "nothing was measured", not "everything passes".
 */
const CATEGORY_LABELS: Record<string, string> = {
  asr: 'Attack Surface Reduction',
  firewall: 'Firewall',
  encryption: 'Encryption',
  endpoint: 'Endpoint',
  identity: 'Identity',
  other: 'Other',
};

function CheckVerdict({ status }: { status: string }) {
  if (status === 'not_applicable') return <span className="text-xs text-fg-subtle">N/A</span>;
  const icon = status === 'pass' ? CheckCircle : status === 'fail' ? XCircle : AlertTriangle;
  return (
    <StatusBadge tone={statusTone(status === 'pass' ? 'approved' : status)} icon={icon}>
      {humanizeStatus(status)}
    </StatusBadge>
  );
}

export interface BaselinePanelProps {
  checks: BaselineCheck[];
  /** Whether the baseline query FAILED, as opposed to returning nothing. The distinction is the point. */
  isError: boolean;
}

export function BaselinePanel({ checks, isError }: BaselinePanelProps) {
  const [showPassing, setShowPassing] = useState(false);

  if (isError) {
    return (
      <div
        role="alert"
        className="flex items-center gap-2 rounded-xl border border-border bg-surface-muted px-4 py-3"
      >
        <ShieldAlert className="h-4 w-4 text-fg-subtle" />
        <p className="text-sm text-fg-muted">
          Couldn&apos;t check the baseline. This is not a pass — the checks were not read.
        </p>
      </div>
    );
  }

  if (checks.length === 0) return null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-fg">Baseline Drift Details</h2>
        <div className="flex items-center gap-3">
          <span className="text-xs text-fg-subtle">
            {checks.filter((c) => c.status === 'fail').length} failing ·{' '}
            {checks.filter((c) => c.status === 'pass').length} passing
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowPassing((p) => !p)}
            className="gap-1.5 hover:border-border-strong"
          >
            {showPassing ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            {showPassing ? 'Hide passing' : 'Show passing'}
          </Button>
        </div>
      </div>

      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full text-sm" role="grid" aria-label="Baseline checks">
          <thead>
            <tr className="border-b border-border bg-surface-muted text-left text-xs font-medium text-fg-subtle">
              <th scope="col" className="px-4 py-3">
                Category
              </th>
              <th scope="col" className="px-4 py-3">
                Check
              </th>
              <th scope="col" className="px-4 py-3">
                Status
              </th>
              <th scope="col" className="px-4 py-3 text-right tabular-nums">
                Score
              </th>
            </tr>
          </thead>
          <tbody>
            {checks
              .filter((c) =>
                showPassing
                  ? c.status !== 'not_applicable'
                  : c.status !== 'pass' && c.status !== 'not_applicable',
              )
              .slice(0, 50)
              .map((c) => (
                <tr
                  key={c.id}
                  className="border-b border-border last:border-0 hover:bg-surface-muted/50"
                >
                  <td className="px-4 py-3 text-xs text-fg-muted">
                    {CATEGORY_LABELS[c.category] ?? c.category}
                  </td>
                  <td className="px-4 py-3 text-fg">{c.checkName}</td>
                  <td className="px-4 py-3">
                    <CheckVerdict status={c.status} />
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-fg-muted text-xs">
                    {orDash(c.actualValue)} / {orDash(c.expectedValue)}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      {/*
        A GREEN ALL-CLEAR HAS TO BE EARNED. The error and empty cases are handled above, so reaching
        here means the query succeeded and returned checks — which is exactly the pair of facts the old
        condition ("no failing check in the array") did not require. An errored request left that array
        empty and rendered this banner: a security attestation produced by a dropped fetch.
      */}
      {checks.filter((c) => c.status !== 'pass' && c.status !== 'not_applicable').length === 0 && (
        <div className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 dark:border-emerald-900/30 dark:bg-emerald-950/20">
          <ShieldCheck className="h-4 w-4 text-emerald-600" />
          <p className="text-sm text-emerald-700 dark:text-emerald-400">
            All {checks.length} baseline checks are passing.
          </p>
        </div>
      )}
    </div>
  );
}
