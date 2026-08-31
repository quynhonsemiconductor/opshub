import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, FileText, Plus } from 'lucide-react';
import { api } from '@/shared/api/client';
import {
  Badge,
  Button,
  DataTable,
  EntityDetailPanel,
  ListPage,
  PanelAction,
  SegmentedControl,
  SlideOverSection,
  StatusBadge,
  humanizeStatus,
  statusTone,
  type DataTableColumn,
} from '@/shared/ui';
import { useListState } from '@/shared/hooks/use-list-state';
import { usePermissions } from '@/shared/hooks/use-permissions';
import { formatDate, isoDaysFromNow, orDash } from '@/shared/lib/format';
import { ContractHistoryPanel, RenewContractModal } from './contract-renewal';
import {
  ActivateContractModal,
  DraftContractModal,
  TerminateContractModal,
} from './contract-modals';
import { COMPENSATION_HIDDEN, type Contract } from './contract.types';

/**
 * Employment contracts — the second module whose API had no screen.
 *
 * THE PAY COLUMN IS DELIBERATELY UNINFORMATIVE WHEN HIDDEN. `compensation` comes back null both when no
 * figures are recorded AND when the caller lacks `contract.compensation.read`; the API returns the same
 * shape for both so that the absence of a figure cannot be read as evidence that one exists. The UI
 * keeps that property: it says "Not shown" and does not guess which case it is in. Writing
 * "No pay recorded" would leak exactly what the permission protects.
 *
 * THE RENEWAL QUEUE is `endingOnOrBefore`, an API filter that narrows to ACTIVE contracts ending by a
 * date. Computing it here from the row list would only ever see the current page.
 */

/**
 * TYPED AGAINST THE API'S OWN ENUM, so a value it would reject cannot be offered.
 *
 * This listed `expiring_soon`, which is not a `contract_status` — the enum is
 * draft/active/expired/terminated — so the "Expiring" filter sent a value the query DTO's
 * `z.enum` refused, and the request 422'd. It was also redundant: the renewal queue is the
 * `Renewing in 90 days` toggle below, which uses the API's `endingOnOrBefore` filter and works.
 *
 * `''` for All is the absence of a filter, hence the union with the empty string.
 */
const STATUS_FILTERS: { value: Contract['status'] | ''; label: string }[] = [
  { value: '', label: 'All' },
  { value: 'draft', label: 'Draft' },
  { value: 'active', label: 'Active' },
  { value: 'expired', label: 'Expired' },
  { value: 'terminated', label: 'Terminated' },
];

/** 90 days out: the window HR needs to act on a renewal, and the one the API report uses. */
const RENEWAL_HORIZON_DAYS = 90;

function useContracts(status: string, renewalsOnly: boolean, limit: number, offset: number) {
  return useQuery({
    queryKey: ['contracts', 'list', status, renewalsOnly, limit, offset],
    queryFn: async () => {
      const { data, error } = await api.GET('/v1/contracts', {
        params: {
          query: {
            status: (status || undefined) as never,
            endingOnOrBefore: renewalsOnly ? isoDaysFromNow(RENEWAL_HORIZON_DAYS) : undefined,
            limit,
            offset,
          },
        },
      });
      if (error || !data) throw new Error('Failed to load contracts');
      return data;
    },
  });
}

export function ContractsPage() {
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = useState('active');
  const [renewalsOnly, setRenewalsOnly] = useState(false);
  /*
   * GATED ON THE PERMISSION THE API ENFORCES. Every write route on this controller carries
   * `@RequirePermission('contract.manage')`, and this page offered Draft, Activate, Terminate and Renew
   * to anyone who could READ a contract — so `contract.read` alone saw four buttons that answer 403.
   * Twenty-five other pages gate their affordances this way; these four were simply missed.
   */
  const { can } = usePermissions();
  const canManage = can('contract.manage');
  const [drafting, setDrafting] = useState(false);
  const [terminating, setTerminating] = useState<Contract | null>(null);
  const [activating, setActivating] = useState<Contract | null>(null);
  const [renewing, setRenewing] = useState<Contract | null>(null);
  const [selected, setSelected] = useState<Contract | null>(null);
  const list = useListState();

  const contracts = useContracts(statusFilter, renewalsOnly, list.limit, list.offset);
  const invalidate = () => qc.invalidateQueries({ queryKey: ['contracts'] });

  const columns: DataTableColumn<Contract>[] = [
    {
      key: 'reference',
      header: 'Reference',
      cell: (c) => <span className="font-mono text-xs font-medium text-fg">{c.reference}</span>,
    },
    {
      key: 'employee',
      header: 'Employee',
      // The NAME. A Contracts list identified by uuid could not answer "whose terms are these",
      // which is the only reason to look at the column.
      cell: (c) => <span className="text-xs text-fg-muted">{orDash(c.employeeName)}</span>,
    },
    {
      key: 'type',
      header: 'Type',
      cell: (c) => <Badge>{humanizeStatus(c.contractType)}</Badge>,
      hideOnMobile: true,
    },
    { key: 'start', header: 'Start', cell: (c) => formatDate(c.startDate) },
    {
      key: 'end',
      header: 'End',
      // An open-ended contract has no end, which is a fact rather than a gap — hence the em dash and
      // not "ongoing", which would read as a status.
      cell: (c) => formatDate(c.endDate),
      hideOnMobile: true,
    },
    {
      key: 'pay',
      header: 'Pay',
      align: 'right',
      cell: (c) =>
        c.compensation ? (
          <span className="tabular-nums">
            {c.compensation.baseSalary} {c.compensation.salaryCurrency}
            <span className="ml-1 text-xs text-fg-subtle">
              /{humanizeStatus(c.compensation.salaryPeriod).toLowerCase()}
            </span>
          </span>
        ) : (
          <span className="text-xs text-fg-subtle">{COMPENSATION_HIDDEN}</span>
        ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (c) => (
        <StatusBadge tone={statusTone(c.status)}>{humanizeStatus(c.status)}</StatusBadge>
      ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: (c) => (
        <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
          {canManage && c.status === 'draft' && (
            <Button variant="outline" size="sm" onClick={() => setActivating(c)}>
              Activate
            </Button>
          )}
          {canManage && c.status === 'active' && (
            <Button variant="outline" size="sm" onClick={() => setTerminating(c)}>
              Terminate
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <>
      <DraftContractModal
        open={drafting}
        onClose={() => setDrafting(false)}
        onSuccess={invalidate}
      />
      {activating && (
        <ActivateContractModal
          contract={activating}
          onClose={() => setActivating(null)}
          onSuccess={invalidate}
        />
      )}
      {renewing && (
        <RenewContractModal
          contract={renewing}
          onClose={() => setRenewing(null)}
          onSuccess={invalidate}
        />
      )}
      {terminating && (
        <TerminateContractModal
          contract={terminating}
          onClose={() => setTerminating(null)}
          onSuccess={invalidate}
        />
      )}

      <ListPage
        title="Contracts"
        description="Employment terms, their lifecycle, and what renews soon."
        actions={
          canManage ? (
            <Button variant="primary" onClick={() => setDrafting(true)}>
              <Plus className="h-4 w-4" strokeWidth={2} />
              Draft contract
            </Button>
          ) : undefined
        }
        filters={
          <>
            <SegmentedControl
              label="Filter by status"
              options={STATUS_FILTERS}
              value={statusFilter}
              onChange={(value) => {
                setStatusFilter(value);
                setRenewalsOnly(false);
                list.resetPaging();
              }}
            />
            <Button
              variant={renewalsOnly ? 'primary' : 'outline'}
              size="sm"
              aria-pressed={renewalsOnly}
              onClick={() => {
                // A toggle rather than another segment: it NARROWS whatever status is selected, so it
                // is a second axis and not a fifth alternative.
                setRenewalsOnly((v) => !v);
                list.resetPaging();
              }}
            >
              <CalendarClock className="h-3.5 w-3.5" />
              Renewing in {RENEWAL_HORIZON_DAYS} days
            </Button>
          </>
        }
        pageInfo={contracts.data?.pageInfo}
        onOffsetChange={list.goToOffset}
        noun="contracts"
      >
        <DataTable
          columns={columns}
          rows={contracts.data?.data as Contract[] | undefined}
          isLoading={contracts.isLoading}
          isError={contracts.isError}
          errorMessage="Failed to load contracts."
          emptyMessage={
            renewalsOnly ? 'Nothing renewing in that window' : 'No contracts match this filter'
          }
          emptyIcon={FileText}
          emptyAction={
            renewalsOnly || !canManage ? undefined : (
              <Button variant="primary" size="sm" onClick={() => setDrafting(true)}>
                <Plus className="h-3.5 w-3.5" /> Draft contract
              </Button>
            )
          }
          onRowClick={setSelected}
          isRowActive={(c) => c.id === selected?.id}
        />
      </ListPage>

      <EntityDetailPanel
        open={!!selected}
        onClose={() => setSelected(null)}
        width="lg"
        title={selected?.reference ?? 'Contract'}
        description={selected ? humanizeStatus(selected.contractType) : undefined}
        items={
          selected
            ? [
                {
                  label: 'Reference',
                  value: <span className="font-mono text-xs">{selected.reference}</span>,
                },
                {
                  label: 'Status',
                  value: (
                    <StatusBadge tone={statusTone(selected.status)}>
                      {humanizeStatus(selected.status)}
                    </StatusBadge>
                  ),
                },
                {
                  label: 'Employee',
                  value: (
                    <span>
                      {orDash(selected.employeeName)}
                      <span className="ml-2 font-mono text-2xs text-fg-subtle">
                        {selected.employeeId}
                      </span>
                    </span>
                  ),
                },
                {
                  label: 'Position',
                  value: selected.positionId ? (
                    <span className="font-mono text-xs">{selected.positionId}</span>
                  ) : null,
                },
                { label: 'Start', value: formatDate(selected.startDate) },
                { label: 'End', value: formatDate(selected.endDate) },
                { label: 'Probation ends', value: formatDate(selected.probationEndDate) },
                { label: 'Notice period', value: `${selected.noticePeriodDays} days` },
                { label: 'Signed', value: formatDate(selected.signedAt) },
                {
                  label: 'Pay',
                  value: selected.compensation
                    ? `${selected.compensation.baseSalary} ${selected.compensation.salaryCurrency} / ${humanizeStatus(selected.compensation.salaryPeriod).toLowerCase()}`
                    : COMPENSATION_HIDDEN,
                },
                { label: 'Terminated on', value: formatDate(selected.terminatedOn) },
                { label: 'Termination reason', value: selected.terminationReason, wide: true },
                { label: 'Notes', value: selected.notes, wide: true },
              ]
            : []
        }
        headerActions={
          // Only an ACTIVE contract can be renewed — the service refuses any other outgoing status, and a
          // renewal is a swap between two contracts rather than an edit to one.
          canManage && selected && selected.status === 'active' ? (
            <PanelAction tone="accent" onClick={() => setRenewing(selected)}>
              Renew
            </PanelAction>
          ) : undefined
        }
        activity={
          selected ? { resourceId: selected.id, resourceType: 'employment_contract' } : undefined
        }
      >
        {selected && (
          <SlideOverSection title="Employment history">
            <ContractHistoryPanel employeeId={selected.employeeId} />
          </SlideOverSection>
        )}
      </EntityDetailPanel>
    </>
  );
}
