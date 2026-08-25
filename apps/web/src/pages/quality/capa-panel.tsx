import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CircleCheck, RotateCcw } from 'lucide-react';
import { formatDate, orDash } from '@/shared/lib/format';
import { usePermissions } from '@/shared/hooks/use-permissions';
import { Badge, PanelAction, StatusBadge, humanizeStatus, statusTone } from '@/shared/ui';
import type { Capa, Nonconformance } from './quality.types';
import { useNonconformanceCapas } from './use-quality';
import { CapaActions } from './capa-actions';
import { OpenCapaModal } from './capa-modals';

/**
 * One CAPA, read as evidence.
 *
 * SHARED BY BOTH REGISTERS. The finding's drawer and the CAPA queue show the same card, so the cause, the
 * plan and the effectiveness evidence are presented identically wherever somebody meets them — and there is
 * one place to change what a CAPA looks like.
 */
export function CapaCard({
  capa,
  actions = true,
  children,
}: {
  capa: Capa;
  /** Off where the surrounding screen is read-only. */
  actions?: boolean;
  /** Extra context the host screen has and this card does not — the finding, on the queue. */
  children?: React.ReactNode;
}) {
  return (
    // An ARTICLE named by its reference: a CAPA is a self-contained record, and both screens render lists of
    // them with no table to give a row an accessible name. It also means either screen can be addressed by
    // "the card for CAPA-2026-018" rather than by its class names.
    <article
      aria-label={capa.reference}
      className="rounded-md border border-border bg-surface px-2.5 py-2"
    >
      <div className="flex items-center gap-1.5">
        <span className="font-mono text-xs font-medium text-fg">{capa.reference}</span>
        <StatusBadge tone={statusTone(capa.status)}>{humanizeStatus(capa.status)}</StatusBadge>
        {capa.status === 'verified' && (
          <Badge tone="green">
            <CircleCheck className="h-3 w-3" aria-hidden="true" /> Effective
          </Badge>
        )}
        {/* A CAPA back in analysis with a cause already recorded has been round the loop: the first root
            cause was not the root cause, which is worth seeing without opening the history. */}
        {capa.status === 'analysis' && capa.rootCause && (
          <Badge tone="amber">
            <RotateCcw className="h-3 w-3" aria-hidden="true" /> Re-analysis
          </Badge>
        )}
        {/* WHO is answerable, by name. The card showed no owner at all, which reads worse than a
            uuid would: `verify` and `ineffective` are withheld from the owner, so somebody looking at
            a card with no sign-off button had nothing on screen explaining why. */}
        <span className="ml-auto truncate text-xs text-fg-subtle">{orDash(capa.ownerName)}</span>
        <span className="shrink-0 text-xs text-fg-subtle">
          {capa.dueOn ? `Due ${formatDate(capa.dueOn)}` : 'No due date'}
        </span>
      </div>

      {children}

      {capa.rootCause && (
        <p className="mt-1 whitespace-pre-wrap text-xs text-fg-muted">
          <span className="text-fg-subtle">Cause ({humanizeStatus(capa.rootCauseMethod)}):</span>{' '}
          {capa.rootCause}
        </p>
      )}
      {capa.actionPlan && (
        <p className="mt-0.5 whitespace-pre-wrap text-xs text-fg-muted">
          <span className="text-fg-subtle">Plan:</span> {capa.actionPlan}
        </p>
      )}
      {/* The evidence IS the substance of a verified CAPA, so it is shown rather than a tick on its own. */}
      {capa.effectivenessEvidence && (
        <p className="mt-0.5 whitespace-pre-wrap text-xs text-success">
          Evidence: {capa.effectivenessEvidence}
          {capa.verifiedAt && (
            <span className="text-fg-subtle"> · {formatDate(capa.verifiedAt)}</span>
          )}
        </p>
      )}
      {capa.outcomeNote && (
        <p className="mt-0.5 whitespace-pre-wrap text-xs text-warning">{capa.outcomeNote}</p>
      )}

      {actions && (
        <div className="mt-1.5">
          <CapaActions capa={capa} />
        </div>
      )}
    </article>
  );
}

/**
 * The CAPAs on a finding.
 *
 * WHY THEY LIVE IN THE FINDING'S DRAWER. A CAPA has no meaning apart from the non-conformity it answers, and
 * the closure gate is a fact about the pair — so reading one without the other is how a finding sits looking
 * "ready to close" for a month while its only CAPA is still in analysis.
 */
export function CapaPanel({ finding }: { finding: Nonconformance }) {
  const capas = useNonconformanceCapas(finding.id);
  const { can } = usePermissions();
  const queryClient = useQueryClient();
  const [opening, setOpening] = useState(false);

  const rows = capas.data ?? [];
  const canManage = can('capa.manage');
  // A settled finding accepts nothing new, its CAPAs included, so the register stops offering work on it.
  const settled = finding.status === 'closed' || finding.status === 'void';

  function refresh() {
    void queryClient.invalidateQueries({ queryKey: ['quality'] });
  }

  return (
    <div className="flex flex-col gap-2">
      {capas.isLoading && <p className="text-xs text-fg-subtle">Loading…</p>}
      {capas.isError && <p className="text-xs text-danger">Failed to load the CAPAs.</p>}

      {/* The empty state is itself a finding where the grade demands a CAPA: that finding can never close as
          it stands, which is more useful to say than "no CAPAs". */}
      {!capas.isLoading && !capas.isError && rows.length === 0 && (
        <p className={`text-xs ${finding.requiresCapa ? 'text-warning' : 'text-fg-subtle'}`}>
          {finding.requiresCapa
            ? `No CAPA yet — a ${humanizeStatus(finding.severity).toLowerCase()} finding cannot close until one is verified effective`
            : 'No CAPA. This grade can close on containment alone.'}
        </p>
      )}

      {rows.map((capa) => (
        <CapaCard key={capa.id} capa={capa} />
      ))}

      {canManage && !settled && (
        <div>
          <PanelAction tone="accent" onClick={() => setOpening(true)}>
            Open a CAPA
          </PanelAction>
        </div>
      )}

      {opening && (
        <OpenCapaModal
          nonconformanceId={finding.id}
          nonconformanceReference={finding.reference}
          onClose={() => setOpening(false)}
          onSuccess={refresh}
        />
      )}
    </div>
  );
}
