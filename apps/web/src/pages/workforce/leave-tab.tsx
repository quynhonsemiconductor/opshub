import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Calendar } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/shared/api/client';
import { apiErrorMessage } from '@/shared/api/errors';
import {
  DecisionNote,
  Button,
  DataTable,
  DateRangePicker,
  EntityDetailPanel,
  FileUploadWidget,
  FormField,
  PaginationFooter,
  PanelAction,
  RowAction,
  RowActions,
  SegmentedControl,
  SlideOverSection,
  StatusBadge,
  TabToolbar,
  humanizeStatus,
  statusTone,
  type DataTableColumn,
  type DateRange,
} from '@/shared/ui';
import { useLeaveDocumentUrl } from '@/shared/api/attachment-urls';
import { useCurrentUser } from '@/shared/hooks/use-current-user';
import { useListState } from '@/shared/hooks/use-list-state';
import { usePermissions } from '@/shared/hooks/use-permissions';
import { formatDate, orDash } from '@/shared/lib/format';
import {
  canCancelLeave,
  decisionNote,
  decisionReason,
  leaveReviewVerdict,
  LEAVE_REVIEW_PERMISSIONS,
} from './workforce-policy';
import { useBulkReview } from './use-bulk-review';
import { RequestLeaveModal } from './request-leave-modal';
import type { LeaveResponse, LeaveStatus } from '@/shared/api/types';

const LEAVE_FILTERS: { value: LeaveStatus | ''; label: string }[] = [
  { value: '', label: 'All' },
  { value: 'pending', label: 'Pending' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'cancelled', label: 'Cancelled' },
];

export function LeaveTab() {
  const qc = useQueryClient();
  /*
   * WHO IS LOOKING, which this tab did not ask. Both halves are needed and neither alone is enough:
   * `can` answers whether the API would let this caller decide anything at all, and `me.data.sub`
   * answers whose record it is — the question separation of duties turns on. Filing leave stays
   * ungated, because `POST /leave` is `@SelfScoped` and needs no permission.
   */
  const me = useCurrentUser();
  const { can } = usePermissions();
  const canReview = LEAVE_REVIEW_PERMISSIONS.every((permission) => can(permission));
  const [statusFilter, setStatusFilter] = useState<LeaveStatus | ''>('');
  const [dateRange, setDateRange] = useState<DateRange | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [selected, setSelected] = useState<LeaveResponse | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const list = useListState();

  /*
   * THE DOCUMENT ALREADY ATTACHED, re-read whenever a row is opened.
   *
   * In `document` mode the widget has no local preview to fall back on, so this row showed nothing at all
   * for a request that had a certificate attached — the most visible half of the same fault.
   */
  const supportingDoc = useLeaveDocumentUrl(selected?.id ?? null);

  const { data, isLoading, isError } = useQuery({
    // The offset belongs in the key: without it React Query serves page 1 for every page. The date
    // window rides along for the same reason — and as `null`s when cleared, so a cleared filter and
    // a never-set one share a cache entry instead of forking one.
    queryKey: [
      'workforce',
      'leave',
      statusFilter,
      dateRange?.from ?? null,
      dateRange?.to ?? null,
      list.offset,
      list.limit,
    ],
    queryFn: async () => {
      const { data, error } = await api.GET('/v1/workforce/leave', {
        params: {
          query: {
            status: (statusFilter || undefined) as never,
            // Inclusive bounds on the START date: a window that BEGINS in the range, not an overlap
            // test — the API leaves a straddling window to the conflict check, not the list.
            dateFrom: dateRange?.from,
            dateTo: dateRange?.to,
            limit: list.limit,
            offset: list.offset,
          },
        },
      });
      if (error || !data) throw new Error('Failed to load leave');
      return data;
    },
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['workforce', 'leave'] });

  async function reviewLeave(id: string, approve: boolean) {
    const { error } = await api.POST('/v1/workforce/leave/{id}/review', {
      params: { path: { id } },
      body: { approve },
    });
    return error;
  }

  async function handleReview(id: string, approve: boolean) {
    const error = await reviewLeave(id, approve);
    if (error) {
      toast.error(apiErrorMessage(error, `Failed to ${approve ? 'approve' : 'reject'} leave.`));
      return;
    }
    toast.success(`Leave ${approve ? 'approved' : 'rejected'}`);
    invalidate();
  }

  const { reviewing, handleBulkReview } = useBulkReview({
    rows: data?.data as LeaveResponse[] | undefined,
    selectedIds,
    setSelectedIds,
    verdict: (l) => leaveReviewVerdict(l, me.data?.sub, can),
    review: reviewLeave,
    invalidate,
    entityLabel: 'leave',
  });

  async function handleCancel(id: string) {
    const { error } = await api.POST('/v1/workforce/leave/{id}/cancel', {
      params: { path: { id } },
    });
    if (error) {
      toast.error(apiErrorMessage(error, 'Failed to cancel leave request.'));
      return;
    }
    toast.success('Leave request cancelled');
    invalidate();
  }

  const columns: DataTableColumn<LeaveResponse>[] = [
    { key: 'type', header: 'Type', cell: (l) => humanizeStatus(l.leaveType) },
    { key: 'start', header: 'Start', cell: (l) => formatDate(l.startDate) },
    { key: 'end', header: 'End', cell: (l) => formatDate(l.endDate), hideOnMobile: true },
    {
      key: 'days',
      header: 'Days',
      // The cost the API froze at submit — half days included, which is why it is `numeric(5,2)`.
      cell: (l) => orDash(l.workingDays),
      align: 'right',
    },
    {
      key: 'reason',
      header: 'Reason',
      cell: (l) => <span className="text-xs text-fg-subtle">{orDash(l.reason)}</span>,
      className: 'max-w-xs truncate',
      hideOnMobile: true,
    },
    {
      key: 'status',
      header: 'Status',
      cell: (l) => (
        <StatusBadge tone={statusTone(l.status)}>{humanizeStatus(l.status)}</StatusBadge>
      ),
    },
    {
      key: 'actions',
      header: 'Actions',
      /*
       * THREE BUTTONS THAT WERE GATED ON THE STATUS ALONE. Approve and Reject are now offered only where
       * the route guard AND the engine would both allow the click; Cancel is gated the other way round,
       * on owning the row, because withdrawing is the requester's own act.
       *
       * The note and Cancel appear TOGETHER on the viewer's own pending request, and that pairing is the
       * point: it says why the decision is not here and what the requester can do instead.
       */
      cell: (l) => {
        const verdict = leaveReviewVerdict(l, me.data?.sub, can);
        return (
          <RowActions>
            {verdict === 'offer' && (
              <>
                <RowAction tone="success" onClick={() => handleReview(l.id, true)}>
                  Approve
                </RowAction>
                <RowAction tone="danger" onClick={() => handleReview(l.id, false)}>
                  Reject
                </RowAction>
              </>
            )}
            {canCancelLeave(l, me.data?.sub, can) && (
              <RowAction tone="muted" onClick={() => handleCancel(l.id)}>
                Cancel
              </RowAction>
            )}
            <DecisionNote reason={decisionReason(verdict)} />
          </RowActions>
        );
      },
    },
  ];

  // Read once for the drawer, which asks the same two questions about the one open row.
  const selectedVerdict = selected
    ? leaveReviewVerdict(selected, me.data?.sub, can)
    : 'not_pending';
  const selectedCancellable = selected ? canCancelLeave(selected, me.data?.sub, can) : false;
  // An empty header row is a visible gap in the drawer, so the wrapper appears only when it holds
  // something — a button, or the sentence explaining why there is none.
  const showPanelActions =
    selectedVerdict === 'offer' || selectedCancellable || !!decisionNote(selectedVerdict);

  return (
    <>
      <RequestLeaveModal
        open={showForm}
        onClose={() => setShowForm(false)}
        onSuccess={invalidate}
      />

      <div className="flex flex-col gap-4">
        <TabToolbar
          filter={
            <div className="flex flex-wrap items-center gap-2">
              <SegmentedControl
                label="Filter leave by status"
                options={LEAVE_FILTERS}
                value={statusFilter}
                onChange={(value) => {
                  setStatusFilter(value);
                  list.resetPaging();
                }}
              />
              {/*
               * "Starting between", not "between": the API matches requests whose window BEGINS in the
               * range, so a trip straddling the boundary is deliberately not matched — the picker is
               * the active-filter affordance, reading in its two fields as the status strip does.
               */}
              <FormField label="Starting between" htmlFor="leave-filter-range">
                <DateRangePicker
                  id="leave-filter-range"
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
              <Plus className="h-4 w-4" strokeWidth={2} /> Request leave
            </Button>
          }
        />

        <DataTable
          columns={columns}
          rows={data?.data as LeaveResponse[] | undefined}
          isLoading={isLoading}
          isError={isError}
          errorMessage="Failed to load leave records."
          emptyMessage="No leave records found"
          emptyIcon={Calendar}
          emptyAction={
            /*
             * The toolbar action, repeated where an empty table leaves the eyes — and withdrawn once
             * a filter is on, because "add one" is not the answer to "where are the ones matching
             * this". Ungated like the toolbar button: filing leave is `@SelfScoped`, so a permission
             * check here would gate self-service away from most of the organisation.
             */
            statusFilter || dateRange ? undefined : (
              <Button variant="primary" size="sm" onClick={() => setShowForm(true)}>
                <Plus className="h-3.5 w-3.5" /> Request leave
              </Button>
            )
          }
          onRowClick={(l) => setSelected(l)}
          isRowActive={(l) => l.id === selected?.id}
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
          noun="leave records"
        />
      </div>

      <EntityDetailPanel
        open={!!selected}
        onClose={() => setSelected(null)}
        title={selected ? `${humanizeStatus(selected.leaveType)} leave` : 'Leave request'}
        description={
          selected
            ? `${formatDate(selected.startDate)} – ${formatDate(selected.endDate)} · ${humanizeStatus(selected.status)}`
            : undefined
        }
        headerActions={
          selected && showPanelActions ? (
            <div className="flex items-center gap-2">
              {selectedVerdict === 'offer' && (
                <>
                  <PanelAction
                    tone="success"
                    onClick={() => {
                      handleReview(selected.id, true);
                      setSelected(null);
                    }}
                  >
                    Approve
                  </PanelAction>
                  <PanelAction
                    tone="danger"
                    onClick={() => {
                      handleReview(selected.id, false);
                      setSelected(null);
                    }}
                  >
                    Reject
                  </PanelAction>
                </>
              )}
              {selectedCancellable && (
                <PanelAction
                  tone="muted"
                  onClick={() => {
                    handleCancel(selected.id);
                    setSelected(null);
                  }}
                >
                  Cancel
                </PanelAction>
              )}
              <DecisionNote reason={decisionReason(selectedVerdict)} />
            </div>
          ) : undefined
        }
        items={
          selected
            ? [
                { label: 'Type', value: humanizeStatus(selected.leaveType) },
                {
                  label: 'Status',
                  value: (
                    <StatusBadge tone={statusTone(selected.status)}>
                      {humanizeStatus(selected.status)}
                    </StatusBadge>
                  ),
                },
                { label: 'Start', value: formatDate(selected.startDate) },
                { label: 'End', value: formatDate(selected.endDate) },
                { label: 'Working days', value: selected.workingDays },
                { label: 'Reason', value: selected.reason, wide: true },
              ]
            : []
        }
        activity={selected ? { resourceId: selected.id, resourceType: 'leave_request' } : undefined}
      >
        {selected && (
          <SlideOverSection title="Supporting document">
            <FileUploadWidget
              mode="document"
              currentUrl={supportingDoc.data}
              presignUrl={`/v1/workforce/leave-requests/${selected.id}/document/presign`}
              confirmUrl={`/v1/workforce/leave-requests/${selected.id}/document/confirm`}
              accept="application/pdf,image/jpeg,image/png"
              // ONE SOURCE OF TRUTH: refetch and let the readback answer. The widget already shows the
              // file just chosen from its own local state, so there is nothing to bridge — an extra copy of
              // the URL in page state would only be a second thing that could disagree.
              onSuccess={() => {
                void qc.invalidateQueries({ queryKey: ['attachment-url', 'leave-document'] });
              }}
              label="Attach a medical certificate or supporting document (PDF, JPEG, PNG · max 10 MB)"
            />
          </SlideOverSection>
        )}
      </EntityDetailPanel>
    </>
  );
}
