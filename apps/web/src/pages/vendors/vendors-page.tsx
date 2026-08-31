import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Building2, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/shared/api/client';
import { apiErrorMessage } from '@/shared/api/errors';
import {
  Badge,
  Button,
  ConfirmDialog,
  DataTable,
  EntityDetailPanel,
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
import { formatDate, orDash } from '@/shared/lib/format';
import { LastAssessedCell, ProcessorCell } from './vendor-cells';
import { RecordAssessmentModal, VendorReasonModal } from './vendor-decision-modals';
import { RegisterVendorModal, type VendorCorrectionFocus } from './vendor-modals';
import { VendorAssessmentsPanel, VendorRisksPanel } from './vendor-panels';
import {
  CriticalWithoutRiskBanner,
  ReviewGapsBanner,
  UnassessedSpendBanner,
} from './vendor-reports';
import { VENDOR_STATUS_FILTERS } from './vendor.types';
import { useCriticalityLevels, useVendors } from './use-vendors';
import type { Vendor } from './vendor.types';

/**
 * The supplier register: who we depend on, how much, who checked them, and what they put at risk.
 *
 * LETTING A SUPPLIER IN IS A DIFFERENT PERMISSION FROM EDITING ONE. `activate` and `reinstate` need
 * `vendor.approve`; registering, assessing, suspending and terminating need `vendor.manage`. The screen
 * mirrors that split rather than gating everything on one code, because the API's separation is the point:
 * the person who maintains the record is not necessarily the person who may accept the dependency.
 *
 * CRITICALITY IS A SCHEDULE. The level carries its review interval and whether independent evidence is
 * required, so "how often must this be assessed" is answered by reference data rather than by a rule in
 * this file — and `/reports/review-gaps` does the dating.
 *
 * THE THREE REPORTS ARE ON THIS SCREEN, not behind a tab: each is a finding about the register the reader
 * is already looking at, and each renders only when it has something to say.
 */
export function VendorsPage() {
  const qc = useQueryClient();
  const list = useListState();
  const { can } = usePermissions();
  const canManage = can('vendor.manage');
  const canApprove = can('vendor.approve');

  const [status, setStatus] = useState('');
  const [criticality, setCriticality] = useState('');
  const [processorsOnly, setProcessorsOnly] = useState(false);
  const [registering, setRegistering] = useState(false);
  /**
   * The supplier being CORRECTED, not a new one registered. Same form, `PATCH` not `POST`. `focus` says
   * which field the correction was opened ON, so "No DPA" is a route to the field that closes it.
   */
  const [correcting, setCorrecting] = useState<{
    vendor: Vendor;
    focus?: VendorCorrectionFocus;
  } | null>(null);
  const [assessing, setAssessing] = useState<Vendor | null>(null);
  const [reasonFor, setReasonFor] = useState<{
    vendor: Vendor;
    action: 'suspend' | 'terminate';
  } | null>(null);
  const [approving, setApproving] = useState<{
    vendor: Vendor;
    action: 'activate' | 'reinstate';
  } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const vendors = useVendors({
    status,
    criticality,
    processorsOnly,
    search: list.search,
    limit: list.limit,
    offset: list.offset,
  });
  const levels = useCriticalityLevels();
  const invalidate = () => qc.invalidateQueries({ queryKey: ['vendors'] });

  /**
   * The open supplier, READ BACK OUT OF THE LIST rather than held as a copy.
   *
   * `riskCount` is on the row and appears in the drawer's own section heading, so linking a risk from
   * inside the drawer changes it. A snapshot taken when the row was clicked would keep showing the old
   * number directly above the risk that had just been added to it.
   */
  const selected = selectedId
    ? (vendors.data?.data?.find((vendor) => vendor.id === selectedId) ?? null)
    : null;

  async function runApproval() {
    if (!approving) return;
    const { vendor, action } = approving;
    const path = action === 'activate' ? '/v1/vendors/{id}/activate' : '/v1/vendors/{id}/reinstate';
    const { error } = await api.POST(path, { params: { path: { id: vendor.id } } });
    setApproving(null);
    if (error) {
      toast.error(apiErrorMessage(error, `Failed to ${action} the supplier.`));
      return;
    }
    toast.success(action === 'activate' ? 'Supplier activated' : 'Supplier reinstated');
    invalidate();
  }

  function applyFilter(apply: () => void) {
    apply();
    list.resetPaging();
  }

  const columns: DataTableColumn<Vendor>[] = [
    {
      key: 'reference',
      header: 'Reference',
      cell: (vendor) => (
        <span className="font-mono text-xs font-medium text-fg">{vendor.reference}</span>
      ),
    },
    {
      key: 'name',
      header: 'Supplier',
      cell: (vendor) => (
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-fg">{vendor.name}</p>
          <p className="truncate text-xs text-fg-subtle">{vendor.services}</p>
        </div>
      ),
    },
    {
      key: 'criticality',
      header: 'Criticality',
      cell: (vendor) => (
        <Badge tone={statusTone(vendor.criticality)}>{humanizeStatus(vendor.criticality)}</Badge>
      ),
    },
    {
      key: 'processor',
      header: 'Processor',
      cell: (vendor) => (
        <ProcessorCell
          vendor={vendor}
          // Omitted, not disabled, when there is nothing to open — see `ProcessorCell`.
          onRecordAgreement={
            canManage && vendor.status !== 'terminated'
              ? () => setCorrecting({ vendor, focus: 'dataProcessingAgreement' })
              : undefined
          }
        />
      ),
    },
    {
      key: 'assessment',
      header: 'Last assessed',
      cell: (vendor) => <LastAssessedCell vendor={vendor} />,
    },
    {
      key: 'risks',
      header: 'Risks',
      align: 'right',
      cell: (vendor) => <span className="tabular-nums">{vendor.riskCount}</span>,
      hideOnMobile: true,
    },
    {
      key: 'status',
      header: 'Status',
      cell: (vendor) => (
        <StatusBadge tone={statusTone(vendor.status)}>{humanizeStatus(vendor.status)}</StatusBadge>
      ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: (vendor) => (
        <RowActions>
          {/* Approve-gated: letting a supplier in, or back in.
              AND ONLY ONCE ASSESSED. The API refuses activation with `VENDOR_ASSESSMENT_REQUIRED` —
              "has never been assessed, so it cannot be approved for live use" — so offering the button
              before then is offering an action whose only outcome is that refusal. Measured by probing
              the endpoint; the row already carries `lastAssessedAt`, so the screen can tell. */}
          {canApprove && vendor.status === 'prospective' && vendor.lastAssessedAt && (
            <RowAction tone="success" onClick={() => setApproving({ vendor, action: 'activate' })}>
              Activate
            </RowAction>
          )}
          {canApprove && vendor.status === 'suspended' && (
            <RowAction tone="success" onClick={() => setApproving({ vendor, action: 'reinstate' })}>
              Reinstate
            </RowAction>
          )}
          {/* Manage-gated: the record and the judgements about it.
              CORRECT, on anything not terminated. `PATCH /v1/vendors/:id` had existed since the module
              was written with no caller, so criticality — which IS the assessment cadence — the owner,
              the contract window, the notice period and the DPA were permanent once onboarded. A
              terminated supplier is excluded: `update` calls `assertNotTerminated` and answers
              `VENDOR_TERMINATED`, and an action whose only outcome is that refusal is not offered. */}
          {canManage && vendor.status !== 'terminated' && (
            <RowAction tone="muted" onClick={() => setCorrecting({ vendor })}>
              Correct
            </RowAction>
          )}
          {canManage && vendor.status !== 'terminated' && (
            <RowAction tone="accent" onClick={() => setAssessing(vendor)}>
              Assess
            </RowAction>
          )}
          {canManage && vendor.status === 'active' && (
            <RowAction tone="danger" onClick={() => setReasonFor({ vendor, action: 'suspend' })}>
              Suspend
            </RowAction>
          )}
          {canManage && vendor.status !== 'terminated' && (
            <RowAction tone="danger" onClick={() => setReasonFor({ vendor, action: 'terminate' })}>
              Terminate
            </RowAction>
          )}
        </RowActions>
      ),
    },
  ];

  const selectedLevel = levels.data?.find((level) => level.code === selected?.criticality);

  return (
    <>
      <RegisterVendorModal
        open={registering}
        onClose={() => setRegistering(false)}
        onSuccess={invalidate}
      />
      {/* One form, two verbs: `vendor` present means correct the record rather than register a new one. */}
      {correcting && (
        <RegisterVendorModal
          open
          vendor={correcting.vendor}
          focus={correcting.focus}
          onClose={() => setCorrecting(null)}
          onSuccess={invalidate}
        />
      )}
      {assessing && (
        <RecordAssessmentModal
          vendor={assessing}
          onClose={() => setAssessing(null)}
          onSuccess={invalidate}
        />
      )}
      {reasonFor && (
        <VendorReasonModal
          vendor={reasonFor.vendor}
          action={reasonFor.action}
          onClose={() => setReasonFor(null)}
          onSuccess={invalidate}
        />
      )}

      <ConfirmDialog
        open={!!approving}
        onCancel={() => setApproving(null)}
        onConfirm={runApproval}
        title={
          approving?.action === 'activate' ? 'Activate this supplier?' : 'Reinstate this supplier?'
        }
        description={
          approving?.action === 'activate'
            ? 'Accepts the dependency: work can be placed with them, and their assessment schedule starts.'
            : 'Lifts the suspension. Whatever caused it should be recorded as an assessment first.'
        }
        confirmLabel={approving?.action === 'activate' ? 'Activate' : 'Reinstate'}
      />

      <ListPage
        title="Suppliers"
        description="Who we depend on, how critical they are, who has checked them, and what they put at risk."
        actions={
          canManage ? (
            <Button variant="primary" onClick={() => setRegistering(true)}>
              <Plus className="h-4 w-4" strokeWidth={2} />
              Register a supplier
            </Button>
          ) : undefined
        }
        search={{
          value: list.search,
          onChange: list.setSearch,
          placeholder: 'Search suppliers…',
        }}
        filters={
          <>
            <SegmentedControl
              label="Filter by status"
              options={VENDOR_STATUS_FILTERS.map((option) => ({ ...option }))}
              value={status}
              onChange={(value) => applyFilter(() => setStatus(value))}
            />
            <SegmentedControl
              label="Filter by criticality"
              options={[
                { value: '', label: 'Any' },
                { value: 'critical', label: 'Critical' },
                { value: 'high', label: 'High' },
              ]}
              value={criticality}
              onChange={(value) => applyFilter(() => setCriticality(value))}
            />
            <Button
              variant={processorsOnly ? 'primary' : 'outline'}
              size="sm"
              aria-pressed={processorsOnly}
              onClick={() => applyFilter(() => setProcessorsOnly(!processorsOnly))}
            >
              Data processors
            </Button>
          </>
        }
        pageInfo={vendors.data?.pageInfo}
        onOffsetChange={list.goToOffset}
        noun="supplier"
      >
        <div className="mb-4 flex flex-col gap-2">
          <CriticalWithoutRiskBanner />
          <ReviewGapsBanner />
          <UnassessedSpendBanner />
        </div>

        <DataTable
          columns={columns}
          rows={vendors.data?.data}
          isLoading={vendors.isLoading}
          isError={vendors.isError}
          errorMessage="Failed to load the supplier register."
          emptyMessage="No suppliers match these filters"
          emptyIcon={Building2}
          emptyAction={
            list.search || !canManage ? undefined : (
              <Button variant="primary" size="sm" onClick={() => setRegistering(true)}>
                <Plus className="h-3.5 w-3.5" /> Register your first supplier
              </Button>
            )
          }
          onRowClick={(vendor) => setSelectedId(vendor.id)}
          isRowActive={(vendor) => vendor.id === selectedId}
        />
      </ListPage>

      <EntityDetailPanel
        open={!!selected}
        onClose={() => setSelectedId(null)}
        title={selected?.name ?? 'Supplier'}
        description={selected?.reference}
        headerActions={
          selected && canManage && selected.status !== 'terminated' ? (
            <>
              {/* The drawer renders the same findings in words — "Yes — NO DPA recorded" — so it needs
                  the same way to act on them. Same gate: `update` refuses a terminated supplier. */}
              <PanelAction tone="muted" onClick={() => setCorrecting({ vendor: selected })}>
                Correct
              </PanelAction>
              <PanelAction tone="accent" onClick={() => setAssessing(selected)}>
                Assess
              </PanelAction>
            </>
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
                {
                  label: 'Criticality',
                  value: (
                    <Badge tone={statusTone(selected.criticality)}>
                      {humanizeStatus(selected.criticality)}
                    </Badge>
                  ),
                },
                {
                  label: 'Assessment schedule',
                  // Reference data, not a rule restated here.
                  value: selectedLevel
                    ? `Every ${selectedLevel.reviewIntervalMonths} months${
                        selectedLevel.requiresIndependentEvidence
                          ? ' · independent evidence required'
                          : ''
                      }`
                    : orDash(null),
                },
                { label: 'Legal name', value: orDash(selected.legalName) },
                { label: 'Services', wide: true, value: selected.services },
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
                  label: 'Data processor',
                  value: selected.dataProcessor
                    ? selected.dataProcessingAgreementId
                      ? 'Yes — DPA on file'
                      : 'Yes — NO DPA recorded'
                    : 'No',
                },
                ...(selected.dataProcessor
                  ? [{ label: 'Data location', value: orDash(selected.dataLocation) }]
                  : []),
                {
                  label: 'Contract',
                  value: `${formatDate(selected.contractStartsOn)} – ${formatDate(selected.contractEndsOn)}`,
                },
                {
                  label: 'Notice period',
                  value: selected.noticePeriodDays
                    ? `${selected.noticePeriodDays} days`
                    : 'Not recorded',
                },
                { label: 'Review due', value: formatDate(selected.reviewDueOn) },
                // Only once it happened, and with the reason — a termination nobody explained is the gap.
                ...(selected.terminatedAt
                  ? [
                      { label: 'Terminated', value: formatDate(selected.terminatedAt) },
                      {
                        label: 'Termination reason',
                        wide: true,
                        value: orDash(selected.terminationReason),
                      },
                    ]
                  : []),
              ]
            : []
        }
        activity={selected ? { resourceId: selected.id, resourceType: 'vendor' } : undefined}
      >
        {selected && (
          <>
            <SlideOverSection title="Assessments">
              <VendorAssessmentsPanel vendorId={selected.id} />
            </SlideOverSection>
            <SlideOverSection title={`Risks (${selected.riskCount})`}>
              <VendorRisksPanel
                vendorId={selected.id}
                criticality={selected.criticality}
                canManage={canManage}
                terminated={selected.status === 'terminated'}
              />
            </SlideOverSection>
          </>
        )}
      </EntityDetailPanel>
    </>
  );
}
