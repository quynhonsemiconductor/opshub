import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/shared/api/client';
import { apiErrorMessage } from '@/shared/api/errors';
import {
  EntityPicker,
  FormActions,
  FormError,
  FormField,
  Input,
  Modal,
  Select,
  Textarea,
  humanizeStatus,
} from '@/shared/ui';
import { activeEmployeeOptions, roleOptions } from '@/shared/api/picker-sources';
import { isoInstantFromDate, todayIso } from '@/shared/lib/format';
import { CONTRACT_TYPES, SALARY_PERIODS, type Contract } from './contract.types';

/**
 * Draft a contract.
 *
 * A contract is DRAFTED, then activated: the two-step exists because a draft is negotiable and an
 * active contract is the thing an audit checks, so this form never activates on save.
 *
 * The pay fields are optional here. A contract with no compensation recorded is a real state — the
 * figures often arrive after the terms — and requiring them would push somebody to type a placeholder.
 */
export function DraftContractModal({
  open,
  onClose,
  onSuccess,
}: {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [form, setForm] = useState({
    employeeId: '',
    roleId: '',
    reference: '',
    contractType: 'permanent' as (typeof CONTRACT_TYPES)[number],
    startDate: '',
    endDate: '',
    probationEndDate: '',
    noticePeriodDays: '30',
    baseSalary: '',
    salaryCurrency: 'USD',
    salaryPeriod: 'monthly' as (typeof SALARY_PERIODS)[number],
    notes: '',
  });
  const [error, setError] = useState('');

  const fixedTerm = form.contractType === 'fixed_term' || form.contractType === 'internship';

  const mutation = useMutation({
    mutationFn: async () => {
      const { error: err } = await api.POST('/v1/contracts', {
        body: {
          employeeId: form.employeeId,
          roleId: form.roleId || null,
          reference: form.reference,
          contractType: form.contractType,
          startDate: form.startDate,
          endDate: form.endDate || null,
          probationEndDate: form.probationEndDate || null,
          noticePeriodDays: Number(form.noticePeriodDays),
          // Sent only when a figure was entered: an empty string is not zero pay.
          compensation: form.baseSalary
            ? {
                baseSalary: form.baseSalary,
                salaryCurrency: form.salaryCurrency,
                salaryPeriod: form.salaryPeriod,
              }
            : null,
          notes: form.notes || null,
        },
      });
      // The API names the rule it refused on — a duplicate reference, dates that run backwards, an
      // employee that does not exist. Repeating a guess here would only ever be less specific.
      if (err) throw new Error(apiErrorMessage(err, 'Failed to draft the contract.'));
    },
    onSuccess: () => {
      toast.success('Contract drafted');
      onSuccess();
      onClose();
    },
    onError: (e: Error) => setError(e.message),
  });

  function set<K extends keyof typeof form>(k: K, v: (typeof form)[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  return (
    <Modal open={open} onClose={onClose} title="Draft contract">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setError('');
          mutation.mutate();
        }}
        className="flex flex-col gap-4 p-5"
      >
        <div className="grid grid-cols-2 gap-3">
          {/* Both were UUID text boxes. A contract is drafted about a PERSON and a ROLE, and
              neither is something anybody can type from memory. */}
          <FormField label="Employee" htmlFor="c-employee" required>
            <EntityPicker
              id="c-employee"
              queryKey="active-employees"
              value={form.employeeId}
              onChange={(v) => set('employeeId', v)}
              fetchOptions={activeEmployeeOptions}
              placeholder="Search people…"
            />
          </FormField>
          <FormField label="Role" htmlFor="c-role" hint="Optional but recommended.">
            <EntityPicker
              id="c-role"
              queryKey="roles"
              value={form.roleId}
              onChange={(v) => set('roleId', v)}
              fetchOptions={roleOptions}
              placeholder="Search roles…"
            />
          </FormField>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <FormField label="Reference" htmlFor="c-reference" required hint="Quoted in HR records.">
            <Input
              id="c-reference"
              required
              value={form.reference}
              onChange={(e) => set('reference', e.target.value.toUpperCase())}
              placeholder="EMP-2026-014"
            />
          </FormField>
          <FormField label="Type" htmlFor="c-type" required>
            <Select
              id="c-type"
              value={form.contractType}
              onChange={(e) => set('contractType', e.target.value as typeof form.contractType)}
            >
              {CONTRACT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {humanizeStatus(t)}
                </option>
              ))}
            </Select>
          </FormField>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <FormField label="Start date" htmlFor="c-start" required>
            <Input
              id="c-start"
              type="date"
              required
              value={form.startDate}
              onChange={(e) => set('startDate', e.target.value)}
            />
          </FormField>
          <FormField
            label="End date"
            htmlFor="c-end"
            required={fixedTerm}
            hint={
              fixedTerm ? 'A fixed term needs an end.' : 'Leave empty for an open-ended contract.'
            }
          >
            <Input
              id="c-end"
              type="date"
              required={fixedTerm}
              value={form.endDate}
              onChange={(e) => set('endDate', e.target.value)}
            />
          </FormField>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <FormField label="Probation ends" htmlFor="c-probation">
            <Input
              id="c-probation"
              type="date"
              value={form.probationEndDate}
              onChange={(e) => set('probationEndDate', e.target.value)}
            />
          </FormField>
          <FormField label="Notice period (days)" htmlFor="c-notice">
            <Input
              id="c-notice"
              type="number"
              min={0}
              value={form.noticePeriodDays}
              onChange={(e) => set('noticePeriodDays', e.target.value)}
            />
          </FormField>
        </div>

        <fieldset className="grid grid-cols-3 gap-3">
          <legend className="mb-1.5 text-xs font-medium text-fg-muted">
            Compensation <span className="text-fg-subtle">(optional)</span>
          </legend>
          <FormField label="Base salary" htmlFor="c-salary">
            <Input
              id="c-salary"
              value={form.baseSalary}
              onChange={(e) => set('baseSalary', e.target.value)}
              placeholder="5000.00"
            />
          </FormField>
          <FormField label="Currency" htmlFor="c-currency">
            <Input
              id="c-currency"
              value={form.salaryCurrency}
              onChange={(e) => set('salaryCurrency', e.target.value.toUpperCase())}
              maxLength={3}
            />
          </FormField>
          <FormField label="Period" htmlFor="c-period">
            <Select
              id="c-period"
              value={form.salaryPeriod}
              onChange={(e) => set('salaryPeriod', e.target.value as typeof form.salaryPeriod)}
            >
              {SALARY_PERIODS.map((p) => (
                <option key={p} value={p}>
                  {humanizeStatus(p)}
                </option>
              ))}
            </Select>
          </FormField>
        </fieldset>

        <FormField label="Notes" htmlFor="c-notes">
          <Textarea
            id="c-notes"
            value={form.notes}
            onChange={(e) => set('notes', e.target.value)}
          />
        </FormField>

        <FormError message={error} />

        <FormActions loading={mutation.isPending} onClose={onClose} submitLabel="Save draft" />
      </form>
    </Modal>
  );
}

/**
 * Activate a draft, which needs a SIGNATURE DATE.
 *
 * This was a `ConfirmDialog` sending `{}`, on the assumption that the API would default `signedAt` to
 * now. It does not, and rightly: `assertActivatable` refuses with `CONTRACT_NOT_SIGNED` unless a
 * signature date is already recorded or supplied. When a contract was signed is a fact about paper in
 * the world, not about the moment somebody clicked a button, so the API declines to invent it — and a
 * dialog with no field had nothing to send.
 *
 * Hence a form rather than a confirmation: today is offered as the default because activating on the
 * day of signature is the common case, and it stays editable because backdating a signature is normal.
 */
export function ActivateContractModal({
  contract,
  onClose,
  onSuccess,
}: {
  contract: Contract;
  onClose: () => void;
  onSuccess: () => void;
}) {
  // The stored value is an INSTANT and the field is a DAY, so an already-signed draft shows the day of
  // its signature rather than a timestamp nobody typed.
  const [signedAt, setSignedAt] = useState(
    contract.signedAt ? contract.signedAt.slice(0, 10) : todayIso(),
  );
  const [error, setError] = useState('');

  const mutation = useMutation({
    mutationFn: async () => {
      const { error: err } = await api.POST('/v1/contracts/{id}/activate', {
        params: { path: { id: contract.id } },
        // `signedAt` is a `timestamptz` on the API — a day is not a valid value for it.
        body: { signedAt: isoInstantFromDate(signedAt) },
      });
      if (err) throw new Error(apiErrorMessage(err, 'Failed to activate the contract.'));
    },
    onSuccess: () => {
      toast.success('Contract activated');
      onSuccess();
      onClose();
    },
    onError: (e: Error) => setError(e.message),
  });

  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      title={`Activate ${contract.reference}`}
      description="It becomes the employee's binding contract, and any previous active one must already be closed."
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setError('');
          mutation.mutate();
        }}
        className="flex flex-col gap-4 p-5"
      >
        <FormField
          label="Signed on"
          htmlFor="a-signed"
          required
          hint="The date on the signed contract. Recorded as the signature date and cannot be blank."
        >
          <Input
            id="a-signed"
            type="date"
            required
            value={signedAt}
            onChange={(e) => setSignedAt(e.target.value)}
          />
        </FormField>

        <FormError message={error} />

        <FormActions
          loading={mutation.isPending}
          onClose={onClose}
          submitLabel="Activate"
          pendingLabel="Activating…"
        />
      </form>
    </Modal>
  );
}

/**
 * Terminate an active contract.
 *
 * The reason is REQUIRED by the API, and rightly: a termination with no stated reason is unexplainable
 * to the next person reading the record, which for an employment contract is a legal problem rather
 * than a tidiness one.
 */
export function TerminateContractModal({
  contract,
  onClose,
  onSuccess,
}: {
  contract: Contract;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [terminatedOn, setTerminatedOn] = useState(todayIso());
  const [terminationReason, setTerminationReason] = useState('');
  const [error, setError] = useState('');

  const mutation = useMutation({
    mutationFn: async () => {
      const { error: err } = await api.POST('/v1/contracts/{id}/terminate', {
        params: { path: { id: contract.id } },
        body: { terminatedOn, terminationReason },
      });
      if (err) throw new Error(apiErrorMessage(err, 'Failed to terminate the contract.'));
    },
    onSuccess: () => {
      toast.success('Contract terminated');
      onSuccess();
      onClose();
    },
    onError: (e: Error) => setError(e.message),
  });

  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      title={`Terminate ${contract.reference}`}
      description="The contract stops being the employee's current one."
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setError('');
          mutation.mutate();
        }}
        className="flex flex-col gap-4 p-5"
      >
        <FormField label="Terminated on" htmlFor="t-date" required>
          <Input
            id="t-date"
            type="date"
            required
            value={terminatedOn}
            onChange={(e) => setTerminatedOn(e.target.value)}
          />
        </FormField>
        <FormField
          label="Reason"
          htmlFor="t-reason"
          required
          hint="Required by the API — a termination nobody explained cannot be defended later."
        >
          <Textarea
            id="t-reason"
            required
            value={terminationReason}
            onChange={(e) => setTerminationReason(e.target.value)}
            placeholder="Resignation, end of fixed term, mutual agreement…"
          />
        </FormField>

        <FormError message={error} />

        <FormActions
          loading={mutation.isPending}
          onClose={onClose}
          submitLabel="Terminate"
          pendingLabel="Terminating…"
          variant="danger"
        />
      </form>
    </Modal>
  );
}
