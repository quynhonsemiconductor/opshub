import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Plus, ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/shared/api/client';
import { apiErrorMessage } from '@/shared/api/errors';
import { activeEmployeeOptions } from '@/shared/api/picker-sources';
import {
  Badge,
  Button,
  ConfirmDialog,
  DataTable,
  EntityDetailPanel,
  EntityPicker,
  ListPage,
  PanelAction,
  RowAction,
  RowActions,
  SegmentedControl,
  SlideOverSection,
  StatusBadge,
  humanizeStatus,
  statusTone,
  type DataTableColumn,
} from '@/shared/ui';
import { useListState } from '@/shared/hooks/use-list-state';
import { usePermissions } from '@/shared/hooks/use-permissions';
import { formatDate, formatDateTime, orDash } from '@/shared/lib/format';
import { LinkedControlsPanel } from './linked-controls-panel';
import { AssessRiskModal, IdentifyRiskModal } from './risk-modals';
import { AcceptRiskModal, CloseRiskModal } from './risk-exit-modals';
import { TreatmentsPanel } from './treatments-panel';
import { RISK_STATUS_FILTERS, scoreTone } from './risk.types';
import { useRisks } from './use-risks';
import type { Risk } from './risk.types';

/**
 * The ISMS risk register: identify, assess, treat, accept, close.
 *
 * THE UI NEVER DECIDES WHETHER A MOVE IS LEGAL. Every transition is guarded twice in the API — in the
 * service, and again as a `WHERE status = <from>` in the repository so a race is Postgres's decision
 * rather than whoever read first. This screen offers the action that fits the state it can see and shows
 * the refusal when it does not fit; a third copy of the state machine here would be one more thing to
 * disagree with.
 *
 * SCORES ARE READ, NEVER COMPUTED. `inherent_score` and `residual_score` are generated columns. The
 * BANDS are ours (`scoreTone`), because "12 is high" is a policy fact rather than arithmetic — and the
 * same band decides whether accepting a risk needs sign-off.
 */
export function RisksPage() {
  const qc = useQueryClient();
  const list = useListState();
  const { can } = usePermissions();
  const canManage = can('risk.manage');

  const [status, setStatus] = useState('');
  const [ownerId, setOwnerId] = useState('');
  const [minScore, setMinScore] = useState('');
  const [identifying, setIdentifying] = useState(false);
  const [assessing, setAssessing] = useState<Risk | null>(null);
  const [accepting, setAccepting] = useState<Risk | null>(null);
  const [closing, setClosing] = useState<Risk | null>(null);
  const [markingTreated, setMarkingTreated] = useState<Risk | null>(null);
  const [selected, setSelected] = useState<Risk | null>(null);

  const risks = useRisks({
    status,
    ownerId,
    category: '',
    minInherentScore: minScore,
    limit: list.limit,
    offset: list.offset,
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['risks'] });

  async function markTreated() {
    if (!markingTreated) return;
    const { error } = await api.POST('/v1/risks/{id}/treated', {
      params: { path: { id: markingTreated.id } },
      // No residual override: the assessment already set one, and re-sending it here would let this
      // button quietly change the numbers somebody signed off.
      body: {},
    });
    setMarkingTreated(null);
    if (error) {
      // The refusal names which outstanding action is in the way.
      toast.error(apiErrorMessage(error, 'Failed to mark the risk treated.'));
      return;
    }
    toast.success('Risk marked treated');
    invalidate();
  }

  function applyFilter(apply: () => void) {
    apply();
    list.resetPaging();
  }

  const columns: DataTableColumn<Risk>[] = [
    {
      key: 'reference',
      header: 'Reference',
      cell: (risk) => (
        <span className="font-mono text-xs font-medium text-fg">{risk.reference}</span>
      ),
    },
    {
      key: 'title',
      header: 'Risk',
      cell: (risk) => (
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-fg">{risk.title}</p>
          <p className="truncate text-xs text-fg-subtle">{risk.category}</p>
        </div>
      ),
    },
    {
      key: 'inherent',
      header: 'Inherent',
      align: 'right',
      cell: (risk) => (
        <Badge tone={scoreTone(risk.inherentScore)}>
          {orDash(risk.inherentScore)}
          <span className="ml-1 text-fg-subtle">
            ({risk.inherentLikelihood}×{risk.inherentImpact})
          </span>
        </Badge>
      ),
    },
    {
      key: 'residual',
      header: 'Residual',
      align: 'right',
      // No residual until it has been ASSESSED — that absence is the state, not a gap.
      cell: (risk) =>
        risk.residualScore == null ? (
          <span className="text-xs text-fg-subtle">Not assessed</span>
        ) : (
          <Badge tone={scoreTone(risk.residualScore)}>
            {risk.residualScore}
            <span className="ml-1 text-fg-subtle">
              ({risk.residualLikelihood}×{risk.residualImpact})
            </span>
          </Badge>
        ),
    },
    {
      key: 'decision',
      header: 'Decision',
      cell: (risk) =>
        risk.treatmentDecision ? humanizeStatus(risk.treatmentDecision) : orDash(null),
      hideOnMobile: true,
    },
    {
      key: 'reviewDue',
      header: 'Review due',
      cell: (risk) => formatDate(risk.reviewDueOn),
      hideOnMobile: true,
    },
    {
      key: 'status',
      header: 'Status',
      cell: (risk) => (
        <StatusBadge tone={statusTone(risk.status)}>{humanizeStatus(risk.status)}</StatusBadge>
      ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: (risk) =>
        canManage ? (
          <RowActions>
            {risk.status === 'identified' && (
              <RowAction tone="accent" onClick={() => setAssessing(risk)}>
                Assess
              </RowAction>
            )}
            {risk.status === 'assessed' && (
              <RowAction tone="success" onClick={() => setMarkingTreated(risk)}>
                Mark treated
              </RowAction>
            )}
            {/* Accepting needs a RESIDUAL, so it is not offered before assessment: the API refuses with
                "assess it before accepting it", and an action whose only outcome is that refusal is worse
                than no action. Measured — the first version of this screen offered it on `identified`. */}
            {risk.residualScore != null &&
              risk.status !== 'accepted' &&
              risk.status !== 'closed' && (
                <RowAction tone="muted" onClick={() => setAccepting(risk)}>
                  Accept
                </RowAction>
              )}
          </RowActions>
        ) : null,
    },
  ];

  return (
    <>
      <IdentifyRiskModal
        open={identifying}
        onClose={() => setIdentifying(false)}
        onSuccess={invalidate}
      />
      {assessing && (
        <AssessRiskModal
          risk={assessing}
          onClose={() => setAssessing(null)}
          onSuccess={invalidate}
        />
      )}
      {accepting && (
        <AcceptRiskModal
          risk={accepting}
          onClose={() => setAccepting(null)}
          onSuccess={invalidate}
        />
      )}
      {closing && (
        <CloseRiskModal risk={closing} onClose={() => setClosing(null)} onSuccess={invalidate} />
      )}

      <ConfirmDialog
        open={!!markingTreated}
        onCancel={() => setMarkingTreated(null)}
        onConfirm={markTreated}
        title="Mark this risk treated?"
        description="Refused while any treatment action is still outstanding — a risk is not treated because somebody plans to treat it."
        confirmLabel="Mark treated"
      />

      <ListPage
        title="Risk register"
        description="What could go wrong, how bad it would be, what is being done about it, and who carries what is left."
        actions={
          canManage ? (
            <Button variant="primary" onClick={() => setIdentifying(true)}>
              <Plus className="h-4 w-4" strokeWidth={2} />
              Identify a risk
            </Button>
          ) : undefined
        }
        filters={
          <>
            <SegmentedControl
              label="Filter by status"
              options={RISK_STATUS_FILTERS.map((option) => ({ ...option }))}
              value={status}
              onChange={(value) => applyFilter(() => setStatus(value))}
            />
            <div className="w-52">
              <EntityPicker
                ariaLabel="Filter by owner"
                queryKey="active-employees"
                value={ownerId}
                onChange={(value) => applyFilter(() => setOwnerId(value))}
                fetchOptions={activeEmployeeOptions}
                placeholder="Any owner"
              />
            </div>
            {/* The high band, as a filter rather than a number to remember: "show me what needs
                sign-off" is the question a risk committee actually asks. */}
            <Button
              variant={minScore ? 'primary' : 'outline'}
              size="sm"
              aria-pressed={!!minScore}
              onClick={() => applyFilter(() => setMinScore(minScore ? '' : '12'))}
            >
              High band only
            </Button>
          </>
        }
        pageInfo={risks.data?.pageInfo}
        onOffsetChange={list.goToOffset}
        noun="risk"
      >
        <DataTable
          columns={columns}
          rows={risks.data?.data}
          isLoading={risks.isLoading}
          isError={risks.isError}
          errorMessage="Failed to load the risk register."
          emptyMessage="No risks match these filters"
          emptyIcon={ShieldAlert}
          onRowClick={setSelected}
          isRowActive={(risk) => risk.id === selected?.id}
        />
      </ListPage>

      <EntityDetailPanel
        open={!!selected}
        onClose={() => setSelected(null)}
        title={selected?.title ?? 'Risk'}
        description={selected?.reference}
        headerActions={
          selected && canManage && selected.status !== 'closed' ? (
            <PanelAction tone="danger" onClick={() => setClosing(selected)}>
              Close
            </PanelAction>
          ) : undefined
        }
        items={
          selected
            ? [
                {
                  label: 'Status',
                  value: (
                    <StatusBadge tone={statusTone(selected.status)}>
                      {humanizeStatus(selected.status)}
                    </StatusBadge>
                  ),
                },
                { label: 'Category', value: selected.category },
                {
                  label: 'Owner',
                  value: (
                    <span>
                      {orDash(selected.ownerName)}
                      {/* The uuid stays here, secondary: the drawer has room, and it is what somebody
                          quotes in a ticket. */}
                      <span className="ml-2 font-mono text-2xs text-fg-subtle">
                        {selected.ownerId}
                      </span>
                    </span>
                  ),
                },
                {
                  label: 'Inherent',
                  value: `${orDash(selected.inherentScore)} (${selected.inherentLikelihood}×${selected.inherentImpact})`,
                },
                {
                  label: 'Residual',
                  value:
                    selected.residualScore == null
                      ? 'Not assessed'
                      : `${selected.residualScore} (${selected.residualLikelihood}×${selected.residualImpact})`,
                },
                {
                  label: 'Decision',
                  value: selected.treatmentDecision
                    ? humanizeStatus(selected.treatmentDecision)
                    : orDash(null),
                },
                { label: 'Review due', value: formatDate(selected.reviewDueOn) },
                {
                  label: 'Description',
                  wide: true,
                  value: (
                    <p className="whitespace-pre-wrap text-sm text-fg-muted">
                      {selected.description}
                    </p>
                  ),
                },
                // Only when it happened. An empty "accepted by" row on an unaccepted risk reads as an
                // acceptance nobody signed.
                ...(selected.acceptedAt
                  ? [
                      {
                        label: 'Accepted',
                        // BY NAME. This is the signature on the acceptance — the field an auditor reads,
                        // because carrying an exposure rather than treating it is a decision somebody is
                        // answerable for — and it used to render the acceptor's uuid. The uuid stays,
                        // secondary, since it is what gets quoted in a ticket.
                        value: (
                          <span>
                            {formatDateTime(selected.acceptedAt)} by{' '}
                            {orDash(selected.acceptedByName)}
                            {selected.acceptedBy ? (
                              <span className="ml-2 font-mono text-2xs text-fg-subtle">
                                {selected.acceptedBy}
                              </span>
                            ) : null}
                          </span>
                        ),
                      },
                      {
                        label: 'Justification',
                        wide: true,
                        value: orDash(selected.acceptanceJustification),
                      },
                    ]
                  : []),
                ...(selected.acceptedViaRequestId
                  ? [
                      {
                        label: 'Accepted via request',
                        value: (
                          <span className="font-mono text-xs">{selected.acceptedViaRequestId}</span>
                        ),
                      },
                    ]
                  : []),
                ...(selected.closedAt
                  ? [
                      { label: 'Closed', value: formatDateTime(selected.closedAt) },
                      { label: 'Closure note', wide: true, value: orDash(selected.closureNote) },
                    ]
                  : []),
              ]
            : []
        }
        activity={selected ? { resourceId: selected.id, resourceType: 'risk' } : undefined}
      >
        {selected && (
          <>
            <SlideOverSection title="Treatment plan">
              <TreatmentsPanel
                risk={selected}
                // A closed risk's plan is history: changing it would rewrite what was done about
                // something that is no longer live.
                canManage={canManage && selected.status !== 'closed'}
              />
            </SlideOverSection>
            <SlideOverSection title="Controls">
              <LinkedControlsPanel
                risk={selected}
                canManage={canManage && selected.status !== 'closed'}
              />
            </SlideOverSection>
          </>
        )}
      </EntityDetailPanel>
    </>
  );
}
