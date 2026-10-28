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
  Select,
  Textarea,
  type DateRange,
  type FormModalProps,
} from '@/shared/ui';
import { JUSTIFICATION_KINDS, type JustificationKind } from './attendance-model';

/**
 * Nộp đơn giải trình (file an attendance justification): one kind, one date range, the working-day
 * count from the preview endpoint before submit — same shape as the WFH modal, Vietnamese labels.
 */
export function RequestJustificationModal({
  open,
  onClose,
  onSuccess,
  initialDate,
}: FormModalProps & { initialDate?: string }) {
  const [loading, setLoading] = useState(false);
  const [kind, setKind] = useState<JustificationKind>('late');
  // Seeded with the day the tab was opened on — a justification explains a day that already
  // happened, so "yesterday, late" is the common case the picker starts from.
  const [dateRange, setDateRange] = useState<DateRange | null>(
    initialDate ? { from: initialDate, to: initialDate } : null,
  );
  const [rangeTouched, setRangeTouched] = useState(false);
  const [reason, setReason] = useState('');

  const preview = useQuery({
    queryKey: ['workforce', 'justification-preview', dateRange?.from ?? '', dateRange?.to ?? ''],
    enabled: open && dateRange !== null,
    queryFn: async () => {
      const { data, error } = await api.GET('/v1/workforce/attendance/justifications/preview', {
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
    const { error } = await api.POST('/v1/workforce/attendance/justifications', {
      body: { kind, startDate: dateRange.from, endDate: dateRange.to, reason: reason || undefined },
    });
    setLoading(false);
    if (error) {
      toast.error(apiErrorMessage(error, 'Không nộp được đơn giải trình.'));
      return;
    }
    toast.success('Đã nộp đơn giải trình, chờ quản lý duyệt');
    onSuccess();
    onClose();
  }

  return (
    <Modal open={open} onClose={onClose} title="Nộp đơn giải trình chấm công" size="sm">
      <form onSubmit={handleSubmit} className="flex flex-col gap-4 p-5">
        <FormField label="Loại" htmlFor="justification-kind" required>
          <Select
            id="justification-kind"
            value={kind}
            onChange={(e) => setKind(e.target.value as JustificationKind)}
          >
            {JUSTIFICATION_KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField
          label="Ngày"
          htmlFor="justification-range"
          required
          error={rangeTouched && !dateRange ? 'Chọn ngày bắt đầu và kết thúc.' : undefined}
        >
          <DateRangePicker
            id="justification-range"
            value={dateRange}
            onChange={(value) => {
              setDateRange(value);
              if (value) setRangeTouched(false);
            }}
            min={undefined}
          />
        </FormField>
        <p className="text-xs text-fg-subtle" aria-live="polite">
          {preview.data
            ? preview.data.workingDays.length === 1
              ? 'Đơn này giải trình 1 ngày làm việc (thứ Bảy, Chủ nhật và ngày lễ không tính).'
              : `Đơn này giải trình ${preview.data.workingDays.length} ngày làm việc (thứ Bảy, Chủ nhật và ngày lễ không tính).`
            : 'Số ngày làm việc sẽ hiện ra khi bạn chọn ngày.'}
        </p>
        <FormField label="Lý do" htmlFor="justification-reason">
          <Textarea
            id="justification-reason"
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Lý do (không bắt buộc)…"
          />
        </FormField>
        <FormActions loading={loading} onClose={onClose} submitLabel="Nộp đơn" />
      </form>
    </Modal>
  );
}
