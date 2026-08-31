import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Zap } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/shared/api/client';
import { apiErrorMessage } from '@/shared/api/errors';
import {
  DecisionNote,
  Button,
  DataTable,
  DateRangePicker,
  EntityDetailPanel,
  FormActions,
  FormField,
  Input,
  Modal,
  PaginationFooter,
  PanelAction,
  RowAction,
  RowActions,
  SegmentedControl,
  StatusBadge,
  TabToolbar,
  Textarea,
  humanizeStatus,
  statusTone,
  type DataTableColumn,
  type DateRange,
  type FormModalProps,
} from '@/shared/ui';
import { useCurrentUser } from '@/shared/hooks/use-current-user';
import { useListState } from '@/shared/hooks/use-list-state';
import { usePermissions } from '@/shared/hooks/use-permissions';
import { formatDate, orDash, todayIso } from '@/shared/lib/format';
import {
  decisionNote,
  decisionReason,
  overtimeReviewVerdict,
  OVERTIME_REVIEW_PERMISSIONS,
} from './workforce-policy';
import { useBulkReview } from './use-bulk-review';
import type { OvertimeResponse, OvertimeStatus } from '@/shared/api/types';

const OT_FILTERS: { value: OvertimeStatus | ''; label: string }[] = [
  { value: '', label: 'All' },
  { value: 'pending', label: 'Pending' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
];

function LogOvertimeModal({ open, onClose, onSuccess }: FormModalProps) {
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState({ workDate: todayIso(), hours: 2, reason: '' });

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    const { error } = await api.POST('/v1/workforce/overtime', {
      body: { workDate: form.workDate, hours: form.hours, reason: form.reason },
    });
    setLoading(false);
    if (error) {
      toast.error(apiErrorMessage(error, 'Failed to log overtime.'));
      return;
    }
    toast.success('Overtime logged');
    onSuccess();
    onClose();
  }

  return (
    <Modal open={open} onClose={onClose} title="Log overtime" size="sm">
      <form onSubmit={handleSubmit} className="flex flex-col gap-4 p-5">
        <FormField label="Work date" htmlFor="ot-date" required>
          <Input
            id="ot-date"
            type="date"
            required
            value={form.workDate}
            onChange={(e) => setForm((f) => ({ ...f, workDate: e.target.value }))}
          />
        </FormField>
        <FormField label="Hours" htmlFor="ot-hours" required>
          <Input
            id="ot-hours"
            type="number"
            required
            min={0.5}
            max={24}
            step={0.5}
            value={form.hours}
            onChange={(e) => setForm((f) => ({ ...f, hours: Number(e.target.value) }))}
          />
        </FormField>
        <FormField label="Reason" htmlFor="ot-reason" required>
          <Textarea
            id="ot-reason"
            rows={2}
            required
            value={form.reason}
            onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))}
            placeholder="Why was overtime worked?"
          />
        </FormField>
        <FormActions loading={loading} onClose={onClose} submitLabel="Log" />
      </form>
    </Modal>
  );
}

export function OvertimeTab() {
  const qc = useQueryClient();
  /*
   * WHO IS LOOKING. Logging overtime is `@SelfScoped` and stays open to everybody; deciding it is not,
   * and this tab asked neither question. `me.data.sub` is the separation-of-duties operand — overtime is
   * paid work, so approving your own is the decision the engine most needs to refuse.
   */
  const me = useCurrentUser();
  const { can } = usePermissions();
  const canReview = OVERTIME_REVIEW_PERMISSIONS.every((permission) => can(permission));
  const [statusFilter, setStatusFilter] = useState<OvertimeStatus | ''>('');
  const [dateRange, setDateRange] = useState<DateRange | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [selected, setSelected] = useState<OvertimeResponse | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const list = useListState();

  const { data, isLoading, isError } = useQuery({
    // The offset belongs in the key: without it React Query serves page 1 for every page. The date
    // window rides along for the same reason — and as `null`s when cleared, so a cleared filter and
    // a never-set one share a cache entry instead of forking one.
    queryKey: [
      'workforce',
      'overtime',
      statusFilter,
      dateRange?.from ?? null,
      dateRange?.to ?? null,
      list.offset,
      list.limit,
    ],
    queryFn: async () => {
      const { data, error } = await api.GET('/v1/workforce/overtime', {
        params: {
          query: {
            status: (statusFilter || undefined) as never,
            // Inclusive bounds on `workDate` — the same "this pay period" question the timesheets
            // tab asks of the same column.
            dateFrom: dateRange?.from,
            dateTo: dateRange?.to,
            limit: list.limit,
            offset: list.offset,
          },
        },
      });
      if (error || !data) throw new Error('Failed to load overtime');
      return data;
    },
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['workforce', 'overtime'] });

  async function reviewOt(id: string, approve: boolean) {
    const { error } = await api.POST('/v1/workforce/overtime/{id}/review', {
      params: { path: { id } },
      body: { approve },
    });
    return error;
  }

  async function handleReview(id: string, approve: boolean) {
    const error = await reviewOt(id, approve);
    if (error) {
      toast.error(apiErrorMessage(error, `Failed to ${approve ? 'approve' : 'reject'} overtime.`));
      return;
    }
    toast.success(`Overtime ${approve ? 'approved' : 'rejected'}`);
    invalidate();
  }

  const { reviewing, handleBulkReview } = useBulkReview({
    rows: data?.data as OvertimeResponse[] | undefined,
    selectedIds,
    setSelectedIds,
    verdict: (o) => overtimeReviewVerdict(o, me.data?.sub, can),
    review: reviewOt,
    invalidate,
    entityLabel: 'overtime',
  });

  const columns: DataTableColumn<OvertimeResponse>[] = [
    { key: 'workDate', header: 'Work date', cell: (o) => formatDate(o.workDate) },
    { key: 'hours', header: 'Hours', cell: (o) => `${o.hours}h`, align: 'right' },
    {
      key: 'reason',
      header: 'Reason',
      cell: (o) => <span className="text-xs text-fg-subtle">{orDash(o.reason)}</span>,
      className: 'max-w-xs truncate',
      hideOnMobile: true,
    },
    {
      key: 'status',
      header: 'Status',
      cell: (o) => (
        <StatusBadge tone={statusTone(o.status)}>{humanizeStatus(o.status)}</StatusBadge>
      ),
    },
    {
      key: 'actions',
      header: 'Actions',
      /*
       * OFFERED ONLY WHERE THE API WOULD ACCEPT IT. `workforce.approve` gets past the route guard and
       * `workforce.overtime.review` past the engine, so a holder of one and not the other used to see
       * these buttons and got a 403 from inside the transaction.
       */
      cell: (o) => {
        const verdict = overtimeReviewVerdict(o, me.data?.sub, can);
        return (
          <RowActions>
            {verdict === 'offer' && (
              <>
                <RowAction tone="success" onClick={() => handleReview(o.id, true)}>
                  Approve
                </RowAction>
                <RowAction tone="danger" onClick={() => handleReview(o.id, false)}>
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

  // The drawer asks the same question about the one open row, so it reads the same answer.
  const selectedVerdict = selected
    ? overtimeReviewVerdict(selected, me.data?.sub, can)
    : 'not_pending';

  return (
    <>
      <LogOvertimeModal open={showForm} onClose={() => setShowForm(false)} onSuccess={invalidate} />

      <div className="flex flex-col gap-4">
        <TabToolbar
          filter={
            <div className="flex flex-wrap items-center gap-2">
              <SegmentedControl
                label="Filter overtime by status"
                options={OT_FILTERS}
                value={statusFilter}
                onChange={(value) => {
                  setStatusFilter(value);
                  list.resetPaging();
                }}
              />
              {/*
               * The pay-period question, asked of `workDate` exactly as the timesheets tab asks it —
               * same column, same label. The picker IS the active-filter affordance: a set window
               * reads in its two fields and carries the clear button.
               */}
              <FormField label="Worked between" htmlFor="ot-filter-range">
                <DateRangePicker
                  id="ot-filter-range"
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
              <Plus className="h-4 w-4" strokeWidth={2} /> Log overtime
            </Button>
          }
        />

        <DataTable
          columns={columns}
          rows={data?.data as OvertimeResponse[] | undefined}
          isLoading={isLoading}
          isError={isError}
          errorMessage="Failed to load overtime records."
          emptyMessage="No overtime records found"
          emptyIcon={Zap}
          emptyAction={
            /*
             * The toolbar action, repeated where an empty table leaves the eyes — and withdrawn once
             * a filter is on, because "log some" is not the answer to "where are the ones matching
             * this". Ungated like the toolbar button: logging overtime is `@SelfScoped`.
             */
            statusFilter || dateRange ? undefined : (
              <Button variant="primary" size="sm" onClick={() => setShowForm(true)}>
                <Plus className="h-3.5 w-3.5" /> Log your first overtime
              </Button>
            )
          }
          onRowClick={setSelected}
          isRowActive={(o) => o.id === selected?.id}
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
          noun="overtime records"
        />
      </div>

      <EntityDetailPanel
        open={!!selected}
        onClose={() => setSelected(null)}
        title="Overtime record"
        description={selected ? `${formatDate(selected.workDate)} · ${selected.hours}h` : undefined}
        headerActions={
          selected && (selectedVerdict === 'offer' || decisionNote(selectedVerdict)) ? (
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
              <DecisionNote reason={decisionReason(selectedVerdict)} />
            </div>
          ) : undefined
        }
        items={
          selected
            ? [
                { label: 'Work date', value: formatDate(selected.workDate) },
                { label: 'Hours', value: `${selected.hours}h` },
                {
                  label: 'Status',
                  value: (
                    <StatusBadge tone={statusTone(selected.status)}>
                      {humanizeStatus(selected.status)}
                    </StatusBadge>
                  ),
                },
                { label: 'Reason', value: selected.reason, wide: true },
              ]
            : []
        }
        activity={
          selected ? { resourceId: selected.id, resourceType: 'overtime_entry' } : undefined
        }
      />
    </>
  );
}
