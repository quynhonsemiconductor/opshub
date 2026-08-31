/**
 * LogTimesheetModal — one form, three ways to say which days were worked.
 *
 * WHAT REPLACED WHAT, and why. The first version of this form was a bare `type="date"`, a number
 * field defaulting to 480, and whatever validation the browser felt like applying on submit. The
 * date defaulted to nothing, so the common case — logging today — started with an empty required
 * field; "minutes" read as minutes to half the room and as hours to the rest; and a refused submit
 * produced a native tooltip nobody could style, read, or test.
 *
 * The three modes are one SegmentedControl because they are one decision made up front:
 *
 *  - **Single day** — the ordinary case, and the only one with a start/end pair. When both times
 *    are in, they OWN the duration: the minutes field shows the derived span and is disabled,
 *    because two editable numbers for one day is the disagreement the API settles by ignoring one
 *    of them. An end before the start is an overnight shift (the API's own rule), so the only pair
 *    refused here is end === start.
 *  - **Date range** — expands to one draft per day, weekends included; see `timesheet-dates.ts`
 *    for why the skipping decision is the user's, not a rule's.
 *  - **Recurring** — the weekday chips ARE the skipping decision, made explicitly.
 *
 * A range or a repeat goes through `POST /timesheets/bulk` in batches of 50, sequentially. The
 * endpoint is all-or-nothing PER CALL, not across the whole expansion — so a failure is reported
 * by batch, with the date span that was lost and the API's own sentence for why, and the modal
 * STAYS OPEN: half a week logged and no account of the other half is the failure mode the
 * all-or-nothing endpoint exists to prevent, recreated silently by closing on a partial success.
 */
import { useState } from 'react';
import { CalendarDays } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/shared/api/client';
import { apiErrorMessage } from '@/shared/api/errors';
import {
  Button,
  Checkbox,
  DateRangePicker,
  DurationInput,
  FormActions,
  FormError,
  FormField,
  Input,
  Modal,
  SegmentedControl,
  Textarea,
  type DateRange,
  type FormModalProps,
  type SegmentedOption,
} from '@/shared/ui';
import { formatDuration, todayIso } from '@/shared/lib/format';
import type { CreateTimesheetInput } from '@/shared/api/types';
import {
  chunkDrafts,
  expandDates,
  expandToDrafts,
  isCompleteTimePair,
  minutesBetweenTimes,
  onWeekdays,
} from './timesheet-dates';

type LogMode = 'single' | 'range' | 'recurring';

const MODES: SegmentedOption<LogMode>[] = [
  { value: 'single', label: 'Single day' },
  { value: 'range', label: 'Date range' },
  { value: 'recurring', label: 'Recurring' },
];

/** The one line under the eyebrow that says what the chosen mode will do. */
const MODE_DESCRIPTION: Record<LogMode, string> = {
  single: 'One day, one draft.',
  range: 'One draft per day in the window — weekends included.',
  recurring: 'The chosen weekdays across a window.',
};

/** The presets the old number field implied — a half day and a full one, in the API's minutes. */
const DURATION_PRESETS = [
  { label: '4h', minutes: 240 },
  { label: '8h', minutes: 480 },
];

/** ISO weekday numbers (Mon = 1 … Sun = 7), the same encoding `onWeekdays` filters by. */
const WEEKDAY_CHIPS: { label: string; iso: number }[] = [
  { label: 'Mo', iso: 1 },
  { label: 'Tu', iso: 2 },
  { label: 'We', iso: 3 },
  { label: 'Th', iso: 4 },
  { label: 'Fr', iso: 5 },
  { label: 'Sa', iso: 6 },
  { label: 'Su', iso: 7 },
];

/** A batch that came back refused, labelled by the days it would have logged. */
interface BatchFailure {
  span: string;
  message: string;
}

interface FieldErrors {
  workDate?: string;
  times?: string;
  range?: string;
  weekdays?: string;
}

const NO_ERRORS: FieldErrors = {};

export function LogTimesheetModal({ open, onClose, onSuccess }: FormModalProps) {
  const [mode, setMode] = useState<LogMode>('single');
  const [workDate, setWorkDate] = useState(() => todayIso());
  const [minutes, setMinutes] = useState(480);
  const [hasTimes, setHasTimes] = useState(false);
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const [range, setRange] = useState<DateRange | null>(null);
  // Monday to Friday pre-ticked: the common shape of a working week, and one the chips make
  // trivial to change — the alternative, an empty start, turns "Recurring" into an error page.
  const [weekdays, setWeekdays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [note, setNote] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>(NO_ERRORS);
  const [formError, setFormError] = useState<string | null>(null);
  const [batchFailures, setBatchFailures] = useState<BatchFailure[] | null>(null);
  const [batchSummary, setBatchSummary] = useState<{ created: number; total: number } | null>(null);
  const [loading, setLoading] = useState(false);

  // The pair owns the number only when it is complete AND not the refused end === start: a
  // zero-minute span is the typo the form reports, not a duration to preview against the field.
  const timesOwn = hasTimes && isCompleteTimePair(startTime, endTime) && startTime !== endTime;
  const derivedMinutes = timesOwn ? minutesBetweenTimes(startTime, endTime) : minutes;

  // The days a range or repeat would log — also the submit button's count, so the button never
  // promises a number the expansion does not deliver.
  const plannedDates =
    mode !== 'single' && range
      ? mode === 'recurring'
        ? onWeekdays(expandDates(range), weekdays)
        : expandDates(range)
      : [];

  function clearTransient() {
    setFieldErrors(NO_ERRORS);
    setFormError(null);
    setBatchFailures(null);
    setBatchSummary(null);
  }

  function changeMode(next: LogMode) {
    setMode(next);
    clearTransient();
  }

  function resetForm() {
    changeMode('single');
    setWorkDate(todayIso());
    setMinutes(480);
    setHasTimes(false);
    setStartTime('');
    setEndTime('');
    setRange(null);
    setWeekdays([1, 2, 3, 4, 5]);
    setNote('');
  }

  function toggleWeekday(iso: number) {
    setWeekdays((days) =>
      days.includes(iso) ? days.filter((day) => day !== iso) : [...days, iso].sort((a, b) => a - b),
    );
    clearTransient();
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (loading) return;
    if (mode === 'single') {
      await submitSingle();
      return;
    }
    if (!range) {
      setFieldErrors({ range: 'Choose a date range.' });
      return;
    }
    if (mode === 'recurring' && weekdays.length === 0) {
      setFieldErrors({ weekdays: 'Pick at least one weekday.' });
      return;
    }
    if (plannedDates.length === 0) {
      setFieldErrors({ range: 'No chosen weekday falls in this range.' });
      return;
    }
    await submitInBatches(plannedDates);
  }

  async function submitSingle() {
    if (!workDate) {
      setFieldErrors({ workDate: 'Work date is required.' });
      return;
    }
    if (hasTimes && !isCompleteTimePair(startTime, endTime)) {
      setFieldErrors({ times: 'Start and end must be given together.' });
      return;
    }
    if (hasTimes && isCompleteTimePair(startTime, endTime) && startTime === endTime) {
      setFieldErrors({
        times: 'Start and end must differ — equal times describe a zero-minute shift.',
      });
      return;
    }
    const body: CreateTimesheetInput = {
      workDate,
      minutesWorked: derivedMinutes,
      note: note || undefined,
      // The pair travels only when it is complete: the API accepts it as a pair or not at all.
      ...(timesOwn ? { startTime, endTime } : {}),
    };
    setLoading(true);
    const { error } = await api.POST('/v1/workforce/timesheets', { body });
    setLoading(false);
    if (error) {
      // The API's sentence, rendered inline where the form is — a toast would be gone before the
      // reader worked out which field it was about.
      setFormError(apiErrorMessage(error, 'Failed to log timesheet.'));
      return;
    }
    toast.success('Timesheet logged');
    resetForm();
    onSuccess();
    onClose();
  }

  /** One ≤50-entry call per batch, sequentially; a refusal is recorded, never fatal to the rest. */
  async function submitInBatches(dates: string[]) {
    const drafts = expandToDrafts(dates, minutes, note || undefined);
    const batches = chunkDrafts(drafts);
    setLoading(true);
    let created = 0;
    const failures: BatchFailure[] = [];
    for (const batch of batches) {
      const { error } = await api.POST('/v1/workforce/timesheets/bulk', {
        body: { entries: batch },
      });
      if (error) {
        failures.push({
          span: `${batch[0].workDate} – ${batch[batch.length - 1].workDate}`,
          message: apiErrorMessage(error, 'Failed to log timesheets.'),
        });
      } else {
        created += batch.length;
      }
    }
    setLoading(false);
    onSuccess(); // Whatever logged is in the list now, whether or not everything made it.
    if (failures.length === 0) {
      toast.success(`Logged ${created} timesheets`);
      resetForm();
      onClose();
      return;
    }
    setBatchFailures(failures);
    setBatchSummary({ created, total: drafts.length });
  }

  const durationHint = timesOwn
    ? `Derived from the times: ${formatDuration(derivedMinutes)}`
    : formatDuration(minutes);

  return (
    <Modal open={open} onClose={onClose} title="Log timesheet" size="sm">
      <div className="flex items-center gap-3 border-b border-border px-5 py-4">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent-secondary-muted text-accent-secondary-muted-fg">
          <CalendarDays className="h-4 w-4" strokeWidth={1.75} />
        </div>
        <div className="min-w-0">
          <p className="text-2xs font-semibold uppercase tracking-wider text-fg-subtle">
            Timesheets
          </p>
          <p className="truncate text-xs text-fg-muted">{MODE_DESCRIPTION[mode]}</p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4 p-5">
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-fg-muted">Mode</span>
          <SegmentedControl
            label="Logging mode"
            options={MODES}
            value={mode}
            onChange={changeMode}
          />
        </div>

        {mode === 'single' && (
          <>
            <FormField label="Work date" htmlFor="ts-date" required error={fieldErrors.workDate}>
              <Input
                id="ts-date"
                type="date"
                value={workDate}
                error={fieldErrors.workDate}
                onChange={(e) => {
                  setWorkDate(e.target.value);
                  setFieldErrors((errors) => ({ ...errors, workDate: undefined }));
                }}
              />
            </FormField>

            <FormField label="Time worked" htmlFor="ts-minutes" required hint={durationHint}>
              <DurationInput
                id="ts-minutes"
                value={derivedMinutes}
                onChange={setMinutes}
                presets={DURATION_PRESETS}
                min={1}
                max={1440}
                disabled={timesOwn}
                ariaLabel="Time worked"
              />
            </FormField>

            <Checkbox
              checked={hasTimes}
              onChange={(checked) => {
                setHasTimes(checked);
                setFieldErrors((errors) => ({ ...errors, times: undefined }));
              }}
              label="Add start and end time"
              hint="Derives the minutes from the span. An end before the start is an overnight shift."
            />

            {hasTimes && (
              <FormField label="Start and end" htmlFor="ts-start" error={fieldErrors.times}>
                <div className="flex items-center gap-2">
                  <Input
                    id="ts-start"
                    type="time"
                    aria-label="Start time"
                    className="flex-1"
                    value={startTime}
                    error={fieldErrors.times}
                    onChange={(e) => {
                      setStartTime(e.target.value);
                      setFieldErrors((errors) => ({ ...errors, times: undefined }));
                    }}
                  />
                  <span className="text-xs text-fg-subtle" aria-hidden="true">
                    –
                  </span>
                  {/*
                   * The pair fails as one, so both fields flag: the end input points at the same
                   * message FormField renders for the start (`${htmlFor}-error`), which is the id
                   * this label is bound to one line above.
                   */}
                  <Input
                    id="ts-end"
                    type="time"
                    aria-label="End time"
                    className="flex-1"
                    value={endTime}
                    error={fieldErrors.times}
                    aria-describedby={fieldErrors.times ? 'ts-start-error' : undefined}
                    onChange={(e) => {
                      setEndTime(e.target.value);
                      setFieldErrors((errors) => ({ ...errors, times: undefined }));
                    }}
                  />
                </div>
              </FormField>
            )}
          </>
        )}

        {mode !== 'single' && (
          <>
            <FormField
              label={mode === 'recurring' ? 'Between' : 'Dates worked'}
              htmlFor="ts-range"
              required
              error={fieldErrors.range}
              hint={
                plannedDates.length > 0
                  ? `${plannedDates.length} ${plannedDates.length === 1 ? 'day' : 'days'} · ${formatDuration(minutes)} each`
                  : undefined
              }
            >
              <DateRangePicker
                id="ts-range"
                value={range}
                onChange={(value) => {
                  setRange(value);
                  setFieldErrors((errors) => ({ ...errors, range: undefined }));
                }}
              />
            </FormField>

            {mode === 'recurring' && (
              <div className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-fg-muted">Repeat on</span>
                <div role="group" aria-label="Repeat on weekdays" className="flex flex-wrap gap-1">
                  {WEEKDAY_CHIPS.map((chip) => {
                    const pressed = weekdays.includes(chip.iso);
                    // `Button`, not a raw chip button — the raw-button ratchet counts this file, and
                    // an `aria-pressed` toggle is what the chips are. The pressed look is the
                    // DurationInput presets': accent border and muted accent fill, via overrides.
                    return (
                      <Button
                        key={chip.iso}
                        type="button"
                        variant="outline"
                        size="sm"
                        aria-pressed={pressed}
                        onClick={() => toggleWeekday(chip.iso)}
                        className={
                          pressed ? 'border-accent bg-accent-muted text-accent-muted-fg' : undefined
                        }
                      >
                        {chip.label}
                      </Button>
                    );
                  })}
                </div>
                <FormError message={fieldErrors.weekdays} />
              </div>
            )}
          </>
        )}

        <FormField label="Note" htmlFor="ts-note">
          <Textarea
            id="ts-note"
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Optional notes…"
          />
        </FormField>

        {formError && <FormError message={formError} />}

        {batchFailures && batchSummary && (
          <div className="flex flex-col gap-1 rounded-md border border-border bg-surface-muted p-3">
            <p className="text-xs font-medium text-fg">
              Logged {batchSummary.created} of {batchSummary.total}. These batches were refused:
            </p>
            {batchFailures.map((failure) => (
              <FormError key={failure.span} message={`${failure.span}: ${failure.message}`} />
            ))}
          </div>
        )}

        <FormActions
          loading={loading}
          onClose={onClose}
          submitLabel={
            mode === 'single'
              ? 'Log'
              : plannedDates.length > 0
                ? `Log ${plannedDates.length} ${plannedDates.length === 1 ? 'day' : 'days'}`
                : 'Log days'
          }
          pendingLabel="Logging…"
        />
      </form>
    </Modal>
  );
}
