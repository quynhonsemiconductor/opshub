import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Check, ChevronRight } from 'lucide-react';
import { api } from '@/shared/api/client';
import {
  Button,
  DescriptionList,
  FormError,
  FormField,
  Input,
  SegmentedControl,
  SlideOver,
  Textarea,
} from '@/shared/ui';
import { cn } from '@/shared/lib/utils';
import { formatDate } from '@/shared/lib/format';
import type { EmployeeResponse, EquipmentType, PreferredOs } from './people.types';

const WIZARD_STEPS = ['Position', 'Equipment', 'Access', 'Review'] as const;

const EQUIPMENT_OPTIONS = [
  { value: 'laptop', label: 'Laptop', desc: 'Standard mobile workstation' },
  { value: 'desktop', label: 'Desktop', desc: 'Fixed workstation + monitor' },
  { value: 'remote_only', label: 'Remote only', desc: 'No device — uses personal machine' },
  { value: 'byod', label: 'BYOD', desc: 'Bring your own device' },
] as const;

const OS_OPTIONS = [
  { value: 'windows', label: 'Windows' },
  { value: 'macos', label: 'macOS' },
  { value: 'linux', label: 'Linux' },
] as const;

const ACCESS_OPTIONS = [
  'Microsoft 365 / Teams',
  'GitHub / GitLab',
  'Jira / Confluence',
  'Slack',
  'VPN',
  'AWS / Azure console',
  'Database access',
  'Local admin rights',
  'Azure AD PIM role',
];

interface OnboardingWizardProps {
  employee: EmployeeResponse;
  onClose: () => void;
  onSuccess: (requestId: string) => void;
}

/**
 * The four-step onboarding request.
 *
 * WHAT CHANGED BEYOND THE PRIMITIVES
 *
 * The option cards were `<button>`s with a colour for "selected" and nothing else — a screen reader
 * heard four unrelated buttons and could not tell which device type was chosen, and the access list
 * had the same problem nine times over. They are now NATIVE radio and checkbox inputs inside labels:
 * the platform then supplies the group semantics, the checked state, arrow-key and space handling,
 * and the accessible name, none of which had to be written. The card look is unchanged — the input is
 * visually hidden and the label carries the styling.
 *
 * The OS row is a `SegmentedControl`, because that is exactly what it is: one choice from three.
 *
 * The step bodies were also ALL FOUR evaluated on every render (`const steps = [renderA(), renderB(),
 * …]` builds every step and then indexes one). Only the current step is rendered now.
 */
export function OnboardingWizard({ employee, onClose, onSuccess }: OnboardingWizardProps) {
  const [step, setStep] = useState(0);

  // Step 0 — Position
  const [startDate, setStartDate] = useState('');
  const [department, setDepartment] = useState(employee.department ?? '');
  const [jobTitle, setJobTitle] = useState(employee.jobTitle ?? '');
  const [managerName, setManagerName] = useState('');
  const [startDateErr, setStartDateErr] = useState('');

  // Step 1 — Equipment
  const [equipmentType, setEquipmentType] = useState<EquipmentType>('laptop');
  const [preferredOs, setPreferredOs] = useState<PreferredOs>('windows');
  const [equipmentNote, setEquipmentNote] = useState('');

  // Step 2 — Access
  const [accessNeeds, setAccessNeeds] = useState<string[]>(['Microsoft 365 / Teams']);

  const [submitError, setSubmitError] = useState('');

  const mutation = useMutation({
    mutationFn: async () => {
      const { data, error: err } = await api.POST('/v1/workforce/onboarding', {
        body: {
          employeeId: employee.id,
          startDate,
          department: department || undefined,
          jobTitle: jobTitle || undefined,
          managerName: managerName || undefined,
          equipmentType: equipmentType || undefined,
          preferredOs: preferredOs || undefined,
          equipmentNote: equipmentNote || undefined,
          accessNeeds: accessNeeds.length ? accessNeeds : undefined,
        },
      });
      if (err || !data) throw new Error('Failed to submit onboarding request');
      return data;
    },
    onSuccess: (data) => onSuccess(data.requestId),
    onError: (err: Error) => setSubmitError(err.message),
  });

  function toggleAccess(item: string) {
    setAccessNeeds((prev) =>
      prev.includes(item) ? prev.filter((x) => x !== item) : [...prev, item],
    );
  }

  function next() {
    if (step === 0 && !startDate) {
      setStartDateErr('Start date is required');
      return;
    }
    setStartDateErr('');
    setStep((s) => s + 1);
  }

  const isLastStep = step === WIZARD_STEPS.length - 1;

  return (
    <SlideOver
      open
      onClose={onClose}
      width="lg"
      title={`Onboard — ${employee.displayName}`}
      description="Set up position, equipment, and system access for the new hire."
      footer={
        <div className="flex items-center justify-between">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => (step === 0 ? onClose() : setStep((s) => s - 1))}
          >
            {step === 0 ? 'Cancel' : '← Back'}
          </Button>
          {isLastStep ? (
            <Button
              type="button"
              variant="primary"
              size="sm"
              disabled={mutation.isPending}
              onClick={() => mutation.mutate()}
            >
              {mutation.isPending ? 'Submitting…' : 'Submit onboarding'}
            </Button>
          ) : (
            <Button type="button" variant="primary" size="sm" onClick={next}>
              Next <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      }
    >
      <div className="px-6 py-5">
        <StepBar current={step} />

        {/* Only the current step is built. The previous version evaluated all four on every render. */}
        {step === 0 && (
          <div className="flex flex-col gap-4">
            <FormField label="Start date" htmlFor="onb-start" required error={startDateErr}>
              <Input
                id="onb-start"
                type="date"
                value={startDate}
                error={startDateErr}
                onChange={(e) => {
                  setStartDate(e.target.value);
                  setStartDateErr('');
                }}
              />
            </FormField>
            <div className="grid grid-cols-2 gap-3">
              <FormField label="Department" htmlFor="onb-department">
                <Input
                  id="onb-department"
                  value={department}
                  onChange={(e) => setDepartment(e.target.value)}
                  placeholder="Engineering"
                />
              </FormField>
              <FormField label="Job title" htmlFor="onb-title">
                <Input
                  id="onb-title"
                  value={jobTitle}
                  onChange={(e) => setJobTitle(e.target.value)}
                  placeholder="Software Engineer"
                />
              </FormField>
            </div>
            <FormField
              label="Direct manager"
              htmlFor="onb-manager"
              hint="The manager who approves step 1 of the onboarding chain."
            >
              <Input
                id="onb-manager"
                value={managerName}
                onChange={(e) => setManagerName(e.target.value)}
                placeholder="e.g. Jane Smith"
              />
            </FormField>
          </div>
        )}

        {step === 1 && (
          <div className="flex flex-col gap-4">
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-2 text-xs font-medium text-fg-muted">Device type</legend>
              <div className="grid grid-cols-2 gap-2">
                {EQUIPMENT_OPTIONS.map((opt) => (
                  <OptionCard
                    key={opt.value}
                    name="equipment-type"
                    value={opt.value}
                    checked={equipmentType === opt.value}
                    onChange={() => setEquipmentType(opt.value)}
                    label={opt.label}
                    description={opt.desc}
                  />
                ))}
              </div>
            </fieldset>

            <div className="flex flex-col gap-2">
              <span className="text-xs font-medium text-fg-muted">Preferred OS</span>
              <SegmentedControl
                label="Preferred operating system"
                options={OS_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
                value={preferredOs}
                onChange={setPreferredOs}
              />
            </div>

            <FormField label="Notes for IT" htmlFor="onb-equipment-note">
              <Textarea
                id="onb-equipment-note"
                rows={2}
                value={equipmentNote}
                onChange={(e) => setEquipmentNote(e.target.value)}
                placeholder="e.g. needs external monitor, standing desk adapter…"
              />
            </FormField>
          </div>
        )}

        {step === 2 && (
          <fieldset className="flex flex-col gap-3">
            <legend className="text-xs text-fg-muted">
              Select systems the new hire needs access to on day one.
            </legend>
            <div className="flex flex-col gap-1.5">
              {ACCESS_OPTIONS.map((item) => (
                <AccessCheckbox
                  key={item}
                  label={item}
                  checked={accessNeeds.includes(item)}
                  onChange={() => toggleAccess(item)}
                />
              ))}
            </div>
          </fieldset>
        )}

        {step === 3 && (
          <div className="flex flex-col gap-4">
            <ReviewCard title="Position">
              <DescriptionList
                columns={1}
                items={[
                  { label: 'Start date', value: formatDate(startDate) },
                  { label: 'Department', value: department },
                  { label: 'Job title', value: jobTitle },
                  { label: 'Manager', value: managerName },
                ]}
              />
            </ReviewCard>

            <ReviewCard title="Equipment">
              <DescriptionList
                columns={1}
                items={[
                  {
                    label: 'Device type',
                    value: EQUIPMENT_OPTIONS.find((o) => o.value === equipmentType)?.label,
                  },
                  {
                    label: 'Preferred OS',
                    value: OS_OPTIONS.find((o) => o.value === preferredOs)?.label,
                  },
                  { label: 'Notes', value: equipmentNote },
                ]}
              />
            </ReviewCard>

            {accessNeeds.length > 0 && (
              <ReviewCard title="Access needed">
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {accessNeeds.map((a) => (
                    <span
                      key={a}
                      className="rounded-full bg-accent/10 px-2.5 py-0.5 text-xs font-medium text-accent"
                    >
                      {a}
                    </span>
                  ))}
                </div>
              </ReviewCard>
            )}

            <div className="rounded-md border border-border bg-surface-muted px-4 py-3">
              <p className="text-xs text-fg-muted">
                Submitting creates a 3-step approval chain:{' '}
                <strong className="text-fg">Manager → IT → HR</strong>. Track progress under Inbox.
              </p>
            </div>

            <FormError message={submitError} />
          </div>
        )}
      </div>
    </SlideOver>
  );
}

/** Where the reader is, and how far is left. */
function StepBar({ current }: { current: number }) {
  return (
    <ol className="mb-6 flex items-center" aria-label="Onboarding steps">
      {WIZARD_STEPS.map((label, i) => (
        <li key={label} className="flex flex-1 items-center last:flex-none">
          <div className="flex shrink-0 flex-col items-center gap-1">
            <div
              // `aria-current` rather than colour alone: which step you are on is information.
              aria-current={i === current ? 'step' : undefined}
              className={cn(
                'flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold transition-colors',
                i < current && 'bg-accent text-accent-fg',
                i === current && 'bg-accent text-accent-fg ring-2 ring-accent/30',
                i > current && 'border border-border bg-surface-muted text-fg-muted',
              )}
            >
              {i < current ? <Check className="h-3.5 w-3.5" /> : i + 1}
            </div>
            <span
              className={cn(
                'whitespace-nowrap text-2xs font-medium',
                i === current ? 'text-fg' : 'text-fg-muted',
              )}
            >
              {label}
            </span>
          </div>
          {i < WIZARD_STEPS.length - 1 && (
            <div className={cn('mx-2 mb-4 h-px flex-1', i < current ? 'bg-accent' : 'bg-border')} />
          )}
        </li>
      ))}
    </ol>
  );
}

/**
 * A selectable card backed by a REAL radio input.
 *
 * The input is visually hidden, not absent: `peer-checked` styles the label from its state, so the
 * platform keeps the group semantics, the arrow keys and the accessible name while the card keeps its
 * appearance. The `<button>` version it replaces had none of that.
 */
function OptionCard({
  name,
  value,
  checked,
  onChange,
  label,
  description,
}: {
  name: string;
  value: string;
  checked: boolean;
  onChange: () => void;
  label: string;
  description: string;
}) {
  return (
    <label
      className={cn(
        'flex cursor-pointer flex-col gap-0.5 rounded-lg border px-3 py-2.5 transition-colors',
        'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent/40',
        checked
          ? 'border-accent bg-accent/5 ring-1 ring-accent/30'
          : 'border-border bg-surface hover:bg-surface-hover',
      )}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={onChange}
        className="sr-only"
      />
      <span className="text-sm font-medium text-fg">{label}</span>
      <span className="text-xs text-fg-muted">{description}</span>
    </label>
  );
}

/** A checkbox row, likewise backed by a real input rather than a button with a tick drawn on it. */
function AccessCheckbox({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <label
      className={cn(
        'flex cursor-pointer items-center gap-3 rounded-md border px-3 py-2 text-sm transition-colors',
        'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent/40',
        checked
          ? 'border-accent bg-accent/5 text-fg'
          : 'border-border bg-surface text-fg-muted hover:bg-surface-hover',
      )}
    >
      <input type="checkbox" checked={checked} onChange={onChange} className="sr-only" />
      <span
        aria-hidden="true"
        className={cn(
          'flex h-4 w-4 shrink-0 items-center justify-center rounded border',
          checked ? 'border-accent bg-accent' : 'border-border',
        )}
      >
        {checked && <Check className="h-3 w-3 text-white" />}
      </span>
      {label}
    </label>
  );
}

/** A titled box on the review step. Three copies of the same markup, now one. */
function ReviewCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <p className="mb-2 text-2xs font-semibold uppercase tracking-wider text-fg-muted">{title}</p>
      {children}
    </div>
  );
}
