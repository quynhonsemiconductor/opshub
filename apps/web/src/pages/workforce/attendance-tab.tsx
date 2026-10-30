import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Download } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/shared/api/client';
import { apiErrorMessage } from '@/shared/api/errors';
import { usePermissions } from '@/shared/hooks/use-permissions';
import { cn } from '@/shared/lib/utils';
import {
  Button,
  ConfirmDialog,
  FormActions,
  FormField,
  Modal,
  PanelState,
  StatusBadge,
  Textarea,
} from '@/shared/ui';
import { MONTHS, toIso } from '@/shared/ui/date-grid';
import { EM_DASH, formatDate } from '@/shared/lib/format';
import { monthKey as monthKeyOf, shiftMonth } from './wio-calendar-model';
import {
  FLAG_LABEL,
  STATUS_LABEL,
  hoursLabel,
  totalsFor,
  type AttendanceDay,
  type EmployeeAttendanceMonth,
} from './attendance-model';
import { RequestJustificationModal } from './request-justification-modal';

/**
 * Attendance — the derived month: statuses, worked minutes and flags per working day,
 * computed by the API from the door swipes plus the live requests. English labels, to match the rest of the app. This screen is read by everyone at the factory.
 *
 * HR/auditor (workforce.attendance.read) see everyone and get the CSVs; a manager sees themself
 * and their direct reports; an employee sees themself — the API applies the scope, this tab just
 * renders what it gets. Month close is HR's (workforce.attendance.close); reopen is the audited
 * admin override (workforce.attendance.reopen, held only by the wildcard).
 */
export function AttendanceTab() {
  const qc = useQueryClient();
  const { can, hasRole } = usePermissions();
  const today = new Date();
  const [view, setView] = useState({ y: today.getFullYear(), m: today.getMonth() });
  const [selected, setSelected] = useState<string | null>(null);
  const [justificationOpen, setJustificationOpen] = useState(false);
  const [closeConfirm, setCloseConfirm] = useState(false);
  const [reopenConfirm, setReopenConfirm] = useState(false);
  const [reopenNote, setReopenNote] = useState('');

  const month = monthKeyOf(view);
  const queryKey = ['workforce', 'attendance', month] as const;

  const monthQuery = useQuery({
    queryKey,
    queryFn: async () => {
      const { data, error } = await api.GET('/v1/workforce/attendance', {
        params: { query: { month } },
      });
      if (error || !data) throw new Error('Failed to load the attendance month');
      return data;
    },
  });

  const closeMonth = useMutation({
    mutationFn: async () => {
      const { error } = await api.POST('/v1/workforce/attendance/months/{month}/close', {
        params: { path: { month } },
        body: {},
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success(`Month ${month} closed`);
      setCloseConfirm(false);
      return qc.invalidateQueries({ queryKey });
    },
    onError: (error) => toast.error(apiErrorMessage(error, 'Could not close the month.')),
  });

  const reopenMonth = useMutation({
    mutationFn: async () => {
      const { error } = await api.POST('/v1/workforce/attendance/months/{month}/reopen', {
        params: { path: { month } },
        // The reason is REQUIRED by the API and lands in the audit trail — the override's record.
        body: { note: reopenNote },
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success(`Month ${month} reopened`);
      setReopenConfirm(false);
      setReopenNote('');
      return qc.invalidateQueries({ queryKey });
    },
    onError: (error) => toast.error(apiErrorMessage(error, 'Could not reopen the month.')),
  });

  const close = monthQuery.data?.close ?? null;
  const employees = monthQuery.data?.employees ?? [];
  const detail = employees.find((e) => e.id === selected);

  async function downloadCsv(
    path: '/v1/workforce/attendance/summary.csv' | '/v1/workforce/attendance/days.csv',
    filename: string,
  ) {
    const { data, error } = await api.GET(path, { params: { query: { month } }, parseAs: 'text' });
    if (error || typeof data !== 'string') {
      // The API's message when it answered; the fallback is only for when it did not.
      toast.error(apiErrorMessage(error, 'Could not download the CSV.'));
      return;
    }
    const url = URL.createObjectURL(
      new Blob(['\ufeff' + data], { type: 'text/csv;charset=utf-8' }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = `${filename}-${month}.csv`;
    a.click();
    // The download has not necessarily started when click() returns; revoking immediately can
    // cancel it. One tick is enough for the browser to take the reference.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Previous month"
            onClick={() => setView((v) => shiftMonth(v, -1))}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <h2 className="min-w-36 text-center text-sm font-semibold text-fg" aria-live="polite">
            {MONTHS[view.m]} {view.y}
          </h2>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Next month"
            onClick={() => setView((v) => shiftMonth(v, 1))}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {close ? (
            <span className="text-xs text-fg-subtle">
              Month closed ({formatDate(close.closedAt)}) — no new requests or approvals for this
              month.
            </span>
          ) : (
            <span className="text-xs text-fg-subtle">Month not closed.</span>
          )}
          {(can('workforce.attendance.read') || hasRole('manager')) && (
            <>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  void downloadCsv('/v1/workforce/attendance/summary.csv', 'cham-cong-tong-hop')
                }
              >
                <Download className="h-3.5 w-3.5" aria-hidden="true" /> Summary (CSV)
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  void downloadCsv('/v1/workforce/attendance/days.csv', 'cham-cong-theo-ngay')
                }
              >
                <Download className="h-3.5 w-3.5" aria-hidden="true" /> By day (CSV)
              </Button>
            </>
          )}
          {!close && can('workforce.attendance.close') && (
            <Button size="sm" variant="default" onClick={() => setCloseConfirm(true)}>
              Close month
            </Button>
          )}
          {close && can('workforce.attendance.reopen') && (
            <Button size="sm" variant="danger" onClick={() => setReopenConfirm(true)}>
              Reopen month
            </Button>
          )}
        </div>
      </div>

      <PanelState
        query={monthQuery}
        count={employees.length}
        empty="No employees yet."
        error="Could not load attendance data."
      />

      {employees.length > 0 && (
        <div className="flex flex-col gap-4">
          <div className="flex justify-end">
            <Button size="sm" variant="outline" onClick={() => setJustificationOpen(true)}>
              Submit justification
            </Button>
          </div>
          <EmployeeTable employees={employees} onSelect={setSelected} selected={selected} />
          {detail && <EmployeeDetail employee={detail} />}
        </div>
      )}

      <RequestJustificationModal
        open={justificationOpen}
        initialDate={toIso(new Date(today.getTime() - 24 * 60 * 60_000))}
        onClose={() => setJustificationOpen(false)}
        onSuccess={() => void qc.invalidateQueries({ queryKey: ['workforce', 'attendance'] })}
      />
      <ConfirmDialog
        open={closeConfirm}
        variant="warning"
        title={`Close month ${month}?`}
        description="Once closed, no new leave, work-from-home or justification requests are accepted for this month, and existing requests can no longer be approved or cancelled. Reopening needs an administrator."
        confirmLabel="Close month"
        loading={closeMonth.isPending}
        onConfirm={() => closeMonth.mutate()}
        onCancel={() => setCloseConfirm(false)}
      />
      <Modal
        open={reopenConfirm}
        onClose={() => setReopenConfirm(false)}
        title={`Reopen month ${month}?`}
        size="sm"
      >
        <form
          className="flex flex-col gap-4 p-5"
          onSubmit={(e) => {
            e.preventDefault();
            if (reopenNote.trim()) reopenMonth.mutate();
          }}
        >
          <p className="text-xs text-fg-subtle">
            This is an administrator action. A reason is REQUIRED and will be recorded in the audit
            log.
          </p>
          <FormField label="Reason for reopening" htmlFor="reopen-note" required>
            <Textarea
              id="reopen-note"
              rows={2}
              value={reopenNote}
              onChange={(e) => setReopenNote(e.target.value)}
              placeholder="e.g. corrected attendance after re-checking…"
            />
          </FormField>
          <FormActions
            loading={reopenMonth.isPending}
            onClose={() => setReopenConfirm(false)}
            submitLabel="Reopen month"
          />
        </form>
      </Modal>
    </div>
  );
}

const STATUS_TONE: Record<AttendanceDay['status'], Parameters<typeof StatusBadge>[0]['tone']> = {
  holiday: 'violet',
  leave: 'blue',
  wfh: 'amber',
  office: 'green',
  absent: 'red',
};

function EmployeeTable({
  employees,
  selected,
  onSelect,
}: {
  employees: EmployeeAttendanceMonth[];
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-border text-left text-xs text-fg-subtle">
          <th className="py-2 pr-2 font-medium">Employee</th>
          <th className="py-2 pr-2 font-medium">Department</th>
          <th className="py-2 pr-2 text-right font-medium">Office days</th>
          <th className="py-2 pr-2 text-right font-medium">WFH days</th>
          <th className="py-2 pr-2 text-right font-medium">Leave days</th>
          <th className="py-2 pr-2 text-right font-medium">Absences</th>
          <th className="py-2 pr-2 text-right font-medium">Late</th>
          <th className="py-2 pr-2 text-right font-medium">Left early</th>
          <th className="py-2 pr-2 text-right font-medium">Total hours</th>
        </tr>
      </thead>
      <tbody>
        {employees.map((e) => {
          const t = totalsFor(e);
          return (
            <tr
              key={e.id}
              className={cn(
                'cursor-pointer border-b border-border/60 hover:bg-surface-hover',
                selected === e.id && 'bg-surface-muted',
              )}
              onClick={() => onSelect(e.id)}
            >
              <td className="py-2 pr-2 font-medium text-fg">{e.name}</td>
              <td className="py-2 pr-2 text-fg-subtle">{e.department ?? EM_DASH}</td>
              <td className="py-2 pr-2 text-right">{t.officeDays}</td>
              <td className="py-2 pr-2 text-right">{t.wfhDays}</td>
              <td className="py-2 pr-2 text-right">{t.leaveDays}</td>
              <td
                className={cn(
                  'py-2 pr-2 text-right',
                  t.absences > 0 && 'font-semibold text-danger',
                )}
              >
                {t.absences}
              </td>
              <td className="py-2 pr-2 text-right">{t.lateCount}</td>
              <td className="py-2 pr-2 text-right">{t.earlyCount}</td>
              <td className="py-2 pr-2 text-right">{hoursLabel(t.hours)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** One employee's days, expanded under the table row group when selected. */
function EmployeeDetail({ employee }: { employee: EmployeeAttendanceMonth }) {
  return (
    <section
      aria-label={`Daily attendance for ${employee.name}`}
      className="rounded-lg border border-border bg-surface p-4"
    >
      <h3 className="mb-3 text-sm font-semibold text-fg">{employee.name} — daily</h3>
      <ul className="flex flex-col gap-1.5">
        {employee.days.map((day) => (
          <li key={day.date} className="flex flex-wrap items-baseline gap-2 text-sm">
            <span className="w-24 text-fg-subtle">{formatDate(day.date)}</span>
            <StatusBadge tone={STATUS_TONE[day.status]}>{STATUS_LABEL[day.status]}</StatusBadge>
            <span className="text-fg-subtle">{hoursLabel(day.workedMinutes / 60)} h</span>
            {day.flags.map((flag) => (
              <span key={flag} className="text-xs text-warning">
                {FLAG_LABEL[flag]}
                {flag === 'late' && day.lateMinutes ? ` (${day.lateMinutes} min)` : null}
                {flag === 'early' && day.earlyMinutes ? ` (${day.earlyMinutes} min)` : null}
              </span>
            ))}
            {day.pendingJustification && (
              <span className="text-xs text-fg-subtle">Justification awaiting approval</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
