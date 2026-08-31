import { useState } from 'react';
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
  humanizeStatus,
  type DateRange,
  type FormModalProps,
} from '@/shared/ui';
import { todayIso } from '@/shared/lib/format';
import type { LeaveType } from '@/shared/api/types';

const LEAVE_TYPES: LeaveType[] = ['annual', 'sick', 'unpaid', 'parental', 'other'];

/**
 * The window is one control, not two independent `type="date"` inputs — those ordered nothing and
 * handed "end before start" to the API as a 422. `DateRangePicker` auto-swaps instead, so there is
 * no invalid window to submit in the first place.
 */
export function RequestLeaveModal({ open, onClose, onSuccess }: FormModalProps) {
  const [loading, setLoading] = useState(false);
  const [leaveType, setLeaveType] = useState<LeaveType>('annual');
  const [dateRange, setDateRange] = useState<DateRange | null>(null);
  const [rangeTouched, setRangeTouched] = useState(false);
  const [reason, setReason] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!dateRange) {
      setRangeTouched(true);
      return;
    }
    setLoading(true);
    const { error } = await api.POST('/v1/workforce/leave', {
      body: {
        leaveType,
        startDate: dateRange.from,
        endDate: dateRange.to,
        reason: reason || undefined,
      },
    });
    setLoading(false);
    if (error) {
      toast.error(apiErrorMessage(error, 'Failed to submit leave request.'));
      return;
    }
    toast.success('Leave request submitted');
    onSuccess();
    onClose();
  }

  return (
    <Modal open={open} onClose={onClose} title="Request leave" size="sm">
      <form onSubmit={handleSubmit} className="flex flex-col gap-4 p-5">
        <FormField label="Leave type" htmlFor="leave-type" required>
          <Select
            id="leave-type"
            value={leaveType}
            onChange={(e) => setLeaveType(e.target.value as LeaveType)}
          >
            {LEAVE_TYPES.map((t) => (
              <option key={t} value={t}>
                {humanizeStatus(t)}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField
          label="Dates"
          htmlFor="leave-range"
          required
          error={rangeTouched && !dateRange ? 'Pick a start and end date.' : undefined}
        >
          <DateRangePicker
            id="leave-range"
            value={dateRange}
            onChange={(value) => {
              setDateRange(value);
              if (value) setRangeTouched(false);
            }}
            min={todayIso()}
          />
        </FormField>
        <FormField label="Reason" htmlFor="leave-reason">
          <Textarea
            id="leave-reason"
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
