import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/shared/api/client';
import { apiErrorMessage } from '@/shared/api/errors';
import {
  DateRangePicker,
  FormActions,
  FormField,
  Modal,
  Textarea,
  type DateRange,
  type FormModalProps,
} from '@/shared/ui';
import { todayIso } from '@/shared/lib/format';

/**
 * File a WFH request. The date range is one control (auto-swapping, same reason as the leave modal),
 * and the COUNT of working days it covers is fetched from `/wfh/preview` and shown before submit:
 * the employee asks for the days they think they are asking for, and the manager approves a number.
 */
export function RequestWfhModal({
  open,
  onClose,
  onSuccess,
  initialDate,
}: FormModalProps & { initialDate?: string }) {
  const [loading, setLoading] = useState(false);
  const [dateRange, setDateRange] = useState<DateRange | null>(
    initialDate ? { from: initialDate, to: initialDate } : null,
  );
  const [rangeTouched, setRangeTouched] = useState(false);
  const [reason, setReason] = useState('');

  const preview = useQuery({
    queryKey: ['workforce', 'wfh-preview', dateRange?.from ?? '', dateRange?.to ?? ''],
    enabled: open && dateRange !== null,
    queryFn: async () => {
      const { data, error } = await api.GET('/v1/workforce/wfh/preview', {
        params: { query: { startDate: dateRange!.from, endDate: dateRange!.to } },
      });
      if (error || !data) throw new Error('Failed to preview the window');
      return data;
    },
  });

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!dateRange) {
      setRangeTouched(true);
      return;
    }
    setLoading(true);
    const { error } = await api.POST('/v1/workforce/wfh', {
      body: {
        startDate: dateRange.from,
        endDate: dateRange.to,
        reason: reason || undefined,
      },
    });
    setLoading(false);
    if (error) {
      toast.error(apiErrorMessage(error, 'Failed to submit the WFH request.'));
      return;
    }
    toast.success('WFH request submitted');
    onSuccess();
    onClose();
  }

  return (
    <Modal open={open} onClose={onClose} title="Request work from home" size="sm">
      <form onSubmit={handleSubmit} className="flex flex-col gap-4 p-5">
        <FormField
          label="Dates"
          htmlFor="wfh-range"
          required
          error={rangeTouched && !dateRange ? 'Pick a start and end date.' : undefined}
        >
          <DateRangePicker
            id="wfh-range"
            value={dateRange}
            onChange={(value) => {
              setDateRange(value);
              if (value) setRangeTouched(false);
            }}
            min={todayIso()}
          />
        </FormField>
        {/* The count is the whole point of the preview: "Fri–Mon" reads like two days and covers one. */}
        <p className="text-xs text-fg-subtle" aria-live="polite">
          {preview.data
            ? preview.data.workingDays.length === 1
              ? 'Covers 1 working day (weekends and public holidays cost nothing).'
              : `Covers ${preview.data.workingDays.length} working days (weekends and public holidays cost nothing).`
            : 'Working days are counted for you once dates are picked.'}
        </p>
        <FormField label="Reason" htmlFor="wfh-reason">
          <Textarea
            id="wfh-reason"
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Optional reason…"
          />
        </FormField>
        <FormActions loading={loading} onClose={onClose} submitLabel="Request" />
      </form>
    </Modal>
  );
}
