import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ClipboardCheck, Link2, ShieldAlert, X } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/shared/api/client';
import { apiErrorMessage } from '@/shared/api/errors';
import { riskOptions } from '@/shared/api/picker-sources';
import {
  Badge,
  Button,
  EntityPicker,
  RowActions,
  StatusBadge,
  Tooltip,
  humanizeStatus,
  statusTone,
} from '@/shared/ui';
import { formatDate, orDash } from '@/shared/lib/format';
import { outcomeTone } from './vendor.types';
import { useVendorAssessments, useVendorRisks } from './use-vendors';

/**
 * What a supplier's drawer has to answer: has anybody checked them, and what do they put at risk.
 */

/**
 * Every assessment, newest first.
 *
 * NEVER ASSESSED IS THE FINDING, not an empty list — a supplier on the register that nobody has ever
 * checked is exactly what the review-gap report exists to surface, so the empty state says that rather
 * than "no assessments".
 *
 * A CONDITIONAL PASS SHOWS ITS CONDITIONS. `pass_with_conditions` is a third outcome on purpose: a pass
 * that owes something is not a pass, and the conditions are the part somebody has to chase.
 */
export function VendorAssessmentsPanel({ vendorId }: { vendorId: string }) {
  const assessments = useVendorAssessments(vendorId);
  const rows = assessments.data ?? [];

  return (
    <div className="flex flex-col gap-2">
      {assessments.isLoading && <p className="text-xs text-fg-subtle">Loading…</p>}
      {assessments.isError && <p className="text-xs text-danger">Failed to load assessments.</p>}
      {!assessments.isLoading && !assessments.isError && rows.length === 0 && (
        <p className="text-xs text-warning">
          Never assessed — this supplier is on the register with nobody having checked them
        </p>
      )}

      {rows.map((assessment) => (
        <div
          key={assessment.id}
          className="rounded-md border border-border bg-surface px-2.5 py-2 text-xs"
        >
          <div className="flex items-center gap-1.5">
            <ClipboardCheck className="h-3.5 w-3.5 shrink-0 text-fg-subtle" strokeWidth={1.75} />
            <Badge tone={outcomeTone(assessment.outcome)}>
              {humanizeStatus(assessment.outcome)}
            </Badge>
            <span className="text-fg-subtle">{formatDate(assessment.assessedAt)}</span>
          </div>
          <p className="mt-1 whitespace-pre-wrap text-fg-muted">{assessment.scope}</p>
          {assessment.findings && (
            <p className="mt-1 whitespace-pre-wrap text-fg-subtle">{assessment.findings}</p>
          )}
          {/* Conditions get their own line and their own colour: they are the outstanding obligation. */}
          {assessment.conditions && (
            <p className="mt-1 whitespace-pre-wrap text-warning">
              Conditions: {assessment.conditions}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * The risks this supplier introduces, and the link itself.
 *
 * THE ABSENCE IS THE FINDING for a critical supplier — which is what `/reports/critical-without-risk`
 * reports from the other side. Named here rather than shown as an empty list, because "no linked risks"
 * on a supplier that could stop the business is a gap and not a clean bill of health. That report is also
 * why linking had to become reachable: it names the gap, and until now nothing on this screen could close
 * it.
 *
 * LINKING IS A `PUT` ON THE PAIR, like the risk-to-control and information-asset-to-device links, and for
 * the same reason: the two ids ARE the fact, so the route is idempotent and linking twice is one link.
 *
 * A TERMINATED SUPPLIER TAKES NO NEW LINK BUT WILL STILL GIVE ONE UP. That asymmetry is the API's, not a
 * choice made here — `VendorService.linkRisk` calls `assertNotTerminated`, `unlinkRisk` does not. What a
 * supplier put at risk while they were engaged stays on the record; correcting a link that was always wrong
 * is a different act. So the picker goes and the unlink buttons stay.
 *
 * EACH ROW SHOWS ITS RISK'S STATUS, which matters because the picker offers closed risks too (the API
 * accepts them). A closed risk standing in as a critical supplier's only linked risk would satisfy the
 * report while meaning nothing, so it is visible here rather than filtered out of sight.
 */
export function VendorRisksPanel({
  vendorId,
  criticality,
  canManage,
  terminated,
}: {
  vendorId: string;
  criticality: string;
  canManage: boolean;
  /** Set when the supplier is terminated — the API refuses a new link, so none is offered. */
  terminated: boolean;
}) {
  const qc = useQueryClient();
  const risks = useVendorRisks(vendorId);
  const [linking, setLinking] = useState('');
  const rows = risks.data ?? [];
  const critical = criticality === 'critical' || criticality === 'high';

  // One key for the register: a link moves this list, the row's `riskCount` and the
  // critical-without-risk report, which are three views of one write.
  const invalidate = () => qc.invalidateQueries({ queryKey: ['vendors'] });

  async function link(riskId: string) {
    const { error } = await api.PUT('/v1/vendors/{id}/risks/{riskId}', {
      params: { path: { id: vendorId, riskId } },
    });
    setLinking('');
    if (error) {
      toast.error(apiErrorMessage(error, 'Failed to link the risk.'));
      return;
    }
    toast.success('Risk linked');
    invalidate();
  }

  async function unlink(riskId: string, reference: string) {
    const { error } = await api.DELETE('/v1/vendors/{id}/risks/{riskId}', {
      params: { path: { id: vendorId, riskId } },
    });
    if (error) {
      toast.error(apiErrorMessage(error, 'Failed to unlink the risk.'));
      return;
    }
    toast.success(`${reference} unlinked`);
    invalidate();
  }

  return (
    <div className="flex flex-col gap-2">
      {risks.isLoading && <p className="text-xs text-fg-subtle">Loading…</p>}
      {risks.isError && <p className="text-xs text-danger">Failed to load the linked risks.</p>}
      {!risks.isLoading && !risks.isError && rows.length === 0 && (
        <p
          className={`flex items-start gap-1.5 text-xs ${critical ? 'text-warning' : 'text-fg-subtle'}`}
        >
          {critical && <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={2} />}
          {critical
            ? 'No linked risk — a supplier at this criticality with nothing in the register is a gap the reports pick up'
            : 'No linked risks'}
        </p>
      )}

      {rows.map((risk) => (
        <div
          key={risk.id}
          className="flex items-center gap-2 rounded-md border border-border bg-surface px-2.5 py-1.5"
        >
          <div className="min-w-0 flex-1">
            <p className="truncate font-mono text-xs font-medium text-fg">{risk.reference}</p>
            <p className="truncate text-xs text-fg-muted">{orDash(risk.title)}</p>
          </div>
          {/* The inherent score, worst-first being how the register itself is ordered. */}
          <span className="shrink-0 tabular-nums text-xs text-fg-subtle">{risk.inherentScore}</span>
          <StatusBadge tone={statusTone(risk.status)}>{humanizeStatus(risk.status)}</StatusBadge>
          {canManage && (
            <RowActions>
              <Tooltip content="Unlink">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Unlink ${risk.reference}`}
                  onClick={() => void unlink(risk.id, risk.reference)}
                >
                  <X className="h-3.5 w-3.5" strokeWidth={2} />
                </Button>
              </Tooltip>
            </RowActions>
          )}
        </div>
      ))}

      {canManage && terminated && (
        <p className="text-xs text-fg-subtle">
          Terminated, so no further risk can be linked — what this supplier put at risk is now a
          record of the engagement.
        </p>
      )}

      {canManage && !terminated && (
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <EntityPicker
              ariaLabel="Risk to link"
              queryKey="risks"
              value={linking}
              onChange={(value) => {
                setLinking(value);
                if (value) void link(value);
              }}
              fetchOptions={riskOptions}
              placeholder="Link a register risk…"
            />
          </div>
          <Link2
            className="h-4 w-4 shrink-0 text-fg-subtle"
            strokeWidth={1.75}
            aria-hidden="true"
          />
        </div>
      )}
    </div>
  );
}
