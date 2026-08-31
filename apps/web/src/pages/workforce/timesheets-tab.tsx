import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Clock, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/shared/api/client';
import { apiErrorMessage } from '@/shared/api/errors';
import {
  Button,
  DataTable,
  DateRangePicker,
  DecisionNote,
  EntityDetailPanel,
  FormField,
  PaginationFooter,
  PanelAction,
  RowAction,
  RowActions,
  SegmentedControl,
  StatusBadge,
  TabToolbar,
  humanizeStatus,
  statusTone,
  type DataTableColumn,
  type DateRange,
} from '@/shared/ui';
import { useCurrentUser } from '@/shared/hooks/use-current-user';
import { useListState } from '@/shared/hooks/use-list-state';
import { usePermissions } from '@/shared/hooks/use-permissions';
import { formatDate, orDash } from '@/shared/lib/format';
import {
  canSubmitTimesheet,
  decisionNote,
  decisionReason,
  TIMESHEET_REVIEW_PERMISSIONS,
  timesheetReviewVerdict,
} from './workforce-policy';
import type { TimesheetResponse, TimesheetStatus } from '@/shared/api/types';
import { LogTimesheetModal } from './log-timesheet-modal';
import { asHoursAndMinutes } from './duration';
import { useBulkReview } from './use-bulk-review';

const TS_FILTERS: { value: TimesheetStatus | ''; label: string }[] = [
  { value: '', label: 'All' },
  { value: 'draft', label: 'Draft' },
  { value: 'submitted', label: 'Submitted' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
];

export function TimesheetsTab() {
  const qc = useQueryClient();
  /*
   * WHO IS LOOKING. Submitting is the owner's own act and needs no permission; reviewing needs
   * `workforce.approve`, and this tab offered both to everybody on every row.
   */
  const me = useCurrentUser();
  const { can } = usePermissions();
  const [statusFilter, setStatusFilter] = useState<TimesheetStatus | ''>('');
  const [dateRange, setDateRange] = useState<DateRange | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [selected, setSelected] = useState<TimesheetResponse | null>(null);
  // Bulk selection exists to review, and only a reviewer can review: wiring it up for somebody who
  // cannot act on a selection is a checkbox column leading to a bar of 403s (rule 11).
  const canReview = TIMESHEET_REVIEW_PERMISSIONS.every((permission) => can(permission));
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const list = useListState();

  const { data, isLoading, isError } = useQuery({
    // The offset belongs in the key: without it React Query serves page 1 for every page. The date
    // window rides along for the same reason — and as `null`s when cleared, so a cleared filter and
    // a never-set one share a cache entry instead of forking one.
    queryKey: [
      'workforce',
      'timesheets',
      statusFilter,
      dateRange?.from ?? null,
      dateRange?.to ?? null,
      list.offset,
      list.limit,
    ],
    queryFn: async () => {
      const { data, error } = await api.GET('/v1/workforce/timesheets', {
        params: {
          query: {
            status: (statusFilter || undefined) as never,
            dateFrom: dateRange?.from,
            dateTo: dateRange?.to,
            limit: list.limit,
            offset: list.offset,
          },
        },
      });
      if (error || !data) throw new Error('Failed to load timesheets');
      return data;
    },
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['workforce', 'timesheets'] });

  async function handleSubmitTs(id: string) {
    const { error } = await api.POST('/v1/workforce/timesheets/{id}/submit', {
      params: { path: { id } },
    });
    if (error) {
      toast.error(apiErrorMessage(error, 'Failed to submit timesheet.'));
      return;
    }
    toast.success('Timesheet submitted for review');
    invalidate();
  }

  /** The per-row review call both the row action and the bulk loop go through. */
  async function reviewTs(id: string, approve: boolean): Promise<unknown> {
    const { error } = await api.POST('/v1/workforce/timesheets/{id}/review', {
      params: { path: { id } },
      body: { approve },
    });
    return error;
  }

  async function handleReviewTs(id: string, approve: boolean) {
    const error = await reviewTs(id, approve);
    if (error) {
      toast.error(apiErrorMessage(error, `Failed to ${approve ? 'approve' : 'reject'} timesheet.`));
      return;
    }
    toast.success(`Timesheet ${approve ? 'approved' : 'rejected'}`);
    invalidate();
  }

  const { reviewing, handleBulkReview } = useBulkReview({
    rows: data?.data as TimesheetResponse[] | undefined,
    selectedIds,
    setSelectedIds,
    verdict: (t) => timesheetReviewVerdict(t, me.data?.sub, can),
    review: reviewTs,
    invalidate,
    entityLabel: 'a timesheet',
  });

  const columns: DataTableColumn<TimesheetResponse>[] = [
    { key: 'workDate', header: 'Work date', cell: (t) => formatDate(t.workDate) },
    {
      key: 'minutes',
      header: 'Minutes',
      cell: (t) => `${t.minutesWorked} min (${asHoursAndMinutes(t.minutesWorked)})`,
    },
    {
      key: 'note',
      header: 'Note',
      cell: (t) => <span className="text-xs text-fg-subtle">{orDash(t.note)}</span>,
      className: 'max-w-xs truncate',
      hideOnMobile: true,
    },
    {
      key: 'status',
      header: 'Status',
      cell: (t) => (
        <StatusBadge tone={statusTone(t.status)}>{humanizeStatus(t.status)}</StatusBadge>
      ),
    },
    {
      key: 'actions',
      header: 'Actions',
      /*
       * TWO DIFFERENT RULES THAT LOOKED LIKE ONE. Submit is `assertOwnerOrApprover` — the owner passes on
       * identity alone, which is why it must NOT be gated on a permission — and Review is
       * `workforce.approve`, withheld on the viewer's own sheet. A draft and a submitted sheet are never
       * both, so only one branch can ever render.
       */
      cell: (t) => {
        const verdict = timesheetReviewVerdict(t, me.data?.sub, can);
        return (
          <RowActions>
            {canSubmitTimesheet(t, me.data?.sub, can) && (
              <RowAction tone="accent" onClick={() => handleSubmitTs(t.id)}>
                Submit
              </RowAction>
            )}
            {verdict === 'offer' && (
              <>
                <RowAction tone="success" onClick={() => handleReviewTs(t.id, true)}>
                  Approve
                </RowAction>
                <RowAction tone="danger" onClick={() => handleReviewTs(t.id, false)}>
                  Reject
                </RowAction>
              </>
            )}
            <DecisionNote reason={decisionReason(verdict)} />
          </RowActions>
        );
      },
    },
  ];

  // Read once for the drawer, which asks the same two questions about the one open row.
  const selectedVerdict = selected
    ? timesheetReviewVerdict(selected, me.data?.sub, can)
    : 'not_pending';
  const selectedSubmittable = selected ? canSubmitTimesheet(selected, me.data?.sub, can) : false;
  // An empty header row is a visible gap in the drawer, so the wrapper appears only when it holds
  // something — a button, or the sentence explaining why there is none.
  const showPanelActions =
    selectedVerdict === 'offer' || selectedSubmittable || !!decisionNote(selectedVerdict);

  return (
    <>
      <LogTimesheetModal
        open={showForm}
        onClose={() => setShowForm(false)}
        onSuccess={invalidate}
      />

      <div className="flex flex-col gap-4">
        <TabToolbar
          filter={
            <div className="flex flex-wrap items-center gap-2">
              <SegmentedControl
                label="Filter timesheets by status"
                options={TS_FILTERS}
                value={statusFilter}
                onChange={(value) => {
                  setStatusFilter(value);
                  list.resetPaging();
                }}
              />
              {/*
               * The pay-period question, asked in the query's own vocabulary (`dateFrom`/`dateTo`).
               * The picker IS the active-filter affordance: a set window reads in its two fields and
               * carries the clear button, exactly as the status strip's active segment reads.
               */}
              <FormField label="Worked between" htmlFor="ts-filter-range">
                <DateRangePicker
                  id="ts-filter-range"
                  value={dateRange}
                  onChange={(value) => {
                    setDateRange(value);
                    list.resetPaging();
                  }}
                />
              </FormField>
            </div>
          }
          action={
            <Button variant="primary" onClick={() => setShowForm(true)}>
              <Plus className="h-4 w-4" strokeWidth={2} /> Log timesheet
            </Button>
          }
        />

        <DataTable
          columns={columns}
          rows={data?.data as TimesheetResponse[] | undefined}
          isLoading={isLoading}
          isError={isError}
          errorMessage="Failed to load timesheets."
          emptyMessage="No timesheets found"
          emptyIcon={Clock}
          emptyAction={
            statusFilter || dateRange ? undefined : (
              <Button variant="primary" size="sm" onClick={() => setShowForm(true)}>
                <Plus className="h-3.5 w-3.5" /> Log your first timesheet
              </Button>
            )
          }
          onRowClick={setSelected}
          isRowActive={(t) => t.id === selected?.id}
          selectedIds={canReview ? selectedIds : undefined}
          onSelectionChange={canReview ? setSelectedIds : undefined}
          bulkActions={
            canReview
              ? (count) => (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-medium text-fg-muted">{count} selected</span>
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={reviewing}
                      onClick={() => handleBulkReview(true)}
                    >
                      Approve
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={reviewing}
                      onClick={() => handleBulkReview(false)}
                    >
                      Reject
                    </Button>
                  </div>
                )
              : undefined
          }
        />

        <PaginationFooter
          pageInfo={data?.pageInfo}
          onOffsetChange={list.goToOffset}
          noun="timesheets"
        />
      </div>

      <EntityDetailPanel
        open={!!selected}
        onClose={() => setSelected(null)}
        title={selected ? formatDate(selected.workDate) : 'Timesheet'}
        description={
          selected
            ? `${selected.minutesWorked} min · ${humanizeStatus(selected.status)}`
            : undefined
        }
        headerActions={
          selected && showPanelActions ? (
            <div className="flex items-center gap-2">
              {selectedSubmittable && (
                <PanelAction
                  tone="accent"
                  onClick={() => {
                    handleSubmitTs(selected.id);
                    setSelected(null);
                  }}
                >
                  Submit
                </PanelAction>
              )}
              {selectedVerdict === 'offer' && (
                <>
                  <PanelAction
                    tone="success"
                    onClick={() => {
                      handleReviewTs(selected.id, true);
                      setSelected(null);
                    }}
                  >
                    Approve
                  </PanelAction>
                  <PanelAction
                    tone="danger"
                    onClick={() => {
                      handleReviewTs(selected.id, false);
                      setSelected(null);
                    }}
                  >
                    Reject
                  </PanelAction>
                </>
              )}
              <DecisionNote reason={decisionReason(selectedVerdict)} />
            </div>
          ) : undefined
        }
        items={
          selected
            ? [
                { label: 'Work date', value: formatDate(selected.workDate) },
                {
                  label: 'Minutes',
                  value: `${selected.minutesWorked} min (${asHoursAndMinutes(selected.minutesWorked)})`,
                },
                {
                  label: 'Status',
                  value: (
                    <StatusBadge tone={statusTone(selected.status)}>
                      {humanizeStatus(selected.status)}
                    </StatusBadge>
                  ),
                },
                { label: 'Note', value: selected.note, wide: true },
              ]
            : []
        }
        activity={selected ? { resourceId: selected.id, resourceType: 'timesheet' } : undefined}
      />
    </>
  );
}
