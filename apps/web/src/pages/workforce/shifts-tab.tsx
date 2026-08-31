import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Moon } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/shared/api/client';
import { apiErrorMessage } from '@/shared/api/errors';
import {
  Button,
  DataTable,
  EntityDetailPanel,
  FormActions,
  FormField,
  Input,
  Modal,
  PaginationFooter,
  SegmentedControl,
  Select,
  TabToolbar,
  Textarea,
  type DataTableColumn,
  type FormModalProps,
} from '@/shared/ui';
import { useListState } from '@/shared/hooks/use-list-state';
import { formatDate, formatDateTime, orDash } from '@/shared/lib/format';
import type { ShiftLogResponse, ShiftType } from '@/shared/api/types';

/**
 * Shift type is THIS screen's vocabulary, so its labels stay here.
 *
 * Not in `status-tone.ts`: that file is for words two or more screens show, and night/on-call/weekend
 * appear nowhere else. A lookup table nobody can attribute to a caller is worse than a local one.
 */
const SHIFT_TYPE_LABEL: Record<ShiftType, string> = {
  night: 'Night',
  on_call: 'On-call',
  weekend: 'Weekend',
};

const SHIFT_FILTERS: { value: ShiftType | ''; label: string }[] = [
  { value: '', label: 'All' },
  { value: 'night', label: 'Night' },
  { value: 'on_call', label: 'On-call' },
  { value: 'weekend', label: 'Weekend' },
];

function LogShiftModal({ open, onClose, onSuccess }: FormModalProps) {
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState({
    shiftType: 'night' as ShiftType,
    startsAt: '',
    endsAt: '',
    note: '',
  });

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    const { error } = await api.POST('/v1/workforce/shifts', {
      body: {
        shiftType: form.shiftType as 'night' | 'on_call' | 'weekend',
        startsAt: new Date(form.startsAt).toISOString(),
        endsAt: new Date(form.endsAt).toISOString(),
        note: form.note || undefined,
      },
    });
    setLoading(false);
    if (error) {
      toast.error(apiErrorMessage(error, 'Failed to log shift.'));
      return;
    }
    toast.success('Shift logged');
    onSuccess();
    onClose();
  }

  return (
    <Modal open={open} onClose={onClose} title="Log shift" size="sm">
      <form onSubmit={handleSubmit} className="flex flex-col gap-4 p-5">
        <FormField label="Shift type" htmlFor="shift-type" required>
          <Select
            id="shift-type"
            value={form.shiftType}
            onChange={(e) => setForm((f) => ({ ...f, shiftType: e.target.value as ShiftType }))}
          >
            {SHIFT_FILTERS.filter((o) => o.value !== '').map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </FormField>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Starts at" htmlFor="shift-start" required>
            <Input
              id="shift-start"
              type="datetime-local"
              required
              value={form.startsAt}
              onChange={(e) => setForm((f) => ({ ...f, startsAt: e.target.value }))}
            />
          </FormField>
          <FormField label="Ends at" htmlFor="shift-end" required>
            <Input
              id="shift-end"
              type="datetime-local"
              required
              value={form.endsAt}
              onChange={(e) => setForm((f) => ({ ...f, endsAt: e.target.value }))}
            />
          </FormField>
        </div>
        <FormField label="Note" htmlFor="shift-note">
          <Textarea
            id="shift-note"
            rows={2}
            value={form.note}
            onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
            placeholder="Optional notes…"
          />
        </FormField>
        <FormActions loading={loading} onClose={onClose} submitLabel="Log" />
      </form>
    </Modal>
  );
}

export function ShiftsTab() {
  const qc = useQueryClient();
  const [typeFilter, setTypeFilter] = useState<ShiftType | ''>('');
  const [showForm, setShowForm] = useState(false);
  const [selected, setSelected] = useState<ShiftLogResponse | null>(null);
  const list = useListState();

  const { data, isLoading, isError } = useQuery({
    queryKey: ['workforce', 'shifts', typeFilter, list.offset, list.limit],
    queryFn: async () => {
      const { data, error } = await api.GET('/v1/workforce/shifts', {
        params: {
          query: {
            shiftType: (typeFilter || undefined) as never,
            limit: list.limit,
            offset: list.offset,
          },
        },
      });
      if (error || !data) throw new Error('Failed to load shifts');
      return data;
    },
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['workforce', 'shifts'] });

  const columns: DataTableColumn<ShiftLogResponse>[] = [
    {
      key: 'type',
      header: 'Type',
      cell: (s) => (
        <span className="inline-flex items-center gap-1.5 text-fg">
          <Moon className="h-3 w-3 text-fg-subtle" strokeWidth={2} />
          {SHIFT_TYPE_LABEL[s.shiftType]}
        </span>
      ),
    },
    { key: 'starts', header: 'Starts', cell: (s) => formatDateTime(s.startsAt) },
    { key: 'ends', header: 'Ends', cell: (s) => formatDateTime(s.endsAt), hideOnMobile: true },
    {
      key: 'note',
      header: 'Note',
      cell: (s) => <span className="text-xs text-fg-subtle">{orDash(s.note)}</span>,
      className: 'max-w-xs truncate',
      hideOnMobile: true,
    },
    {
      key: 'logged',
      header: 'Logged',
      cell: (s) => <span className="text-xs text-fg-subtle">{formatDate(s.createdAt)}</span>,
      hideOnMobile: true,
    },
  ];

  return (
    <>
      <LogShiftModal open={showForm} onClose={() => setShowForm(false)} onSuccess={invalidate} />

      <div className="flex flex-col gap-4">
        <TabToolbar
          filter={
            <SegmentedControl
              label="Filter shifts by type"
              options={SHIFT_FILTERS}
              value={typeFilter}
              onChange={(value) => {
                setTypeFilter(value);
                list.resetPaging();
              }}
            />
          }
          action={
            <Button variant="primary" onClick={() => setShowForm(true)}>
              <Plus className="h-4 w-4" strokeWidth={2} /> Log shift
            </Button>
          }
        />

        <DataTable
          columns={columns}
          rows={data?.data as ShiftLogResponse[] | undefined}
          isLoading={isLoading}
          isError={isError}
          errorMessage="Failed to load shift records."
          emptyMessage="No shift records found"
          emptyIcon={Moon}
          emptyAction={
            /*
             * The toolbar action, repeated where an empty table leaves the eyes — and withdrawn once
             * the type filter is on, because "log one" is not the answer to "where are the night
             * shifts". Ungated like the toolbar button: logging a shift is `@SelfScoped`.
             */
            typeFilter ? undefined : (
              <Button variant="primary" size="sm" onClick={() => setShowForm(true)}>
                <Plus className="h-3.5 w-3.5" /> Log your first shift
              </Button>
            )
          }
          onRowClick={setSelected}
          isRowActive={(s) => s.id === selected?.id}
        />

        <PaginationFooter
          pageInfo={data?.pageInfo}
          onOffsetChange={list.goToOffset}
          noun="shift records"
        />
      </div>

      <EntityDetailPanel
        open={!!selected}
        onClose={() => setSelected(null)}
        title={selected ? `${SHIFT_TYPE_LABEL[selected.shiftType]} shift` : 'Shift record'}
        items={
          selected
            ? [
                { label: 'Type', value: SHIFT_TYPE_LABEL[selected.shiftType] },
                { label: 'Starts', value: formatDateTime(selected.startsAt) },
                { label: 'Ends', value: formatDateTime(selected.endsAt) },
                { label: 'Logged', value: formatDate(selected.createdAt) },
                { label: 'Note', value: selected.note, wide: true },
              ]
            : []
        }
        activity={selected ? { resourceId: selected.id, resourceType: 'shift_log' } : undefined}
      />
    </>
  );
}
