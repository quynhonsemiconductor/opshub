import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/shared/api/client';
import { apiErrorMessage } from '@/shared/api/errors';
import { activeEmployeeOptions, documentOptions } from '@/shared/api/picker-sources';
import {
  Checkbox,
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
import { CRITICALITIES, type Vendor } from './vendor.types';
import { useCriticalityLevels, useDocumentTitle } from './use-vendors';

/**
 * Putting a supplier on the register — AND correcting one already on it.
 *
 * CRITICALITY IS NOT A LABEL, it is a schedule: the level carries the review interval and whether
 * independent evidence is required, both read from the API's reference table and shown where the choice is
 * made. Choosing `critical` commits somebody to assessing it that often — and correcting it moves that
 * cadence, which is why the same hints belong on both verbs rather than only on the first.
 */

/** Which field a correction was opened ON, when it was opened from a specific finding. */
export type VendorCorrectionFocus = 'dataProcessingAgreement';

export function RegisterVendorModal({
  open,
  onClose,
  onSuccess,
  vendor,
  focus,
}: {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
  /**
   * Present to CORRECT an existing supplier rather than register a new one.
   *
   * WHY THIS MODE EXISTS. `PATCH /v1/vendors/:id` has been there since the module was written and no
   * screen called it, so a supplier record was append-only by accident: criticality — which IS the
   * assessment cadence — the relationship owner, the contract window and the notice period were all
   * permanent once somebody was onboarded, and the only way to fix a mistake was to terminate the
   * supplier and register them again, which throws away the assessment history that is the audit
   * evidence.
   *
   * `UpdateVendorSchema` is `RegisterVendorSchema.omit({ reference: true }).partial()` — the register
   * form minus the reference — so the same form serves both, with one set of hints.
   */
  vendor?: Vendor;
  /**
   * Open the form ON a field, for a correction started from the finding that named it.
   *
   * The register's "No DPA" badge is a red finding with no way in: `dataProcessingAgreementId` was
   * settable in the schema and in no form at all, so the screen shouted about a gap the product gave
   * nobody a way to close. Clicking the badge now lands here.
   */
  focus?: VendorCorrectionFocus;
}) {
  const editing = !!vendor;
  const levels = useCriticalityLevels();
  const [form, setForm] = useState({
    reference: vendor?.reference ?? '',
    name: vendor?.name ?? '',
    legalName: vendor?.legalName ?? '',
    services: vendor?.services ?? '',
    criticality: (vendor?.criticality ?? 'medium') as (typeof CRITICALITIES)[number],
    ownerId: vendor?.ownerId ?? '',
    dataProcessor: vendor?.dataProcessor ?? false,
    dataProcessingAgreementId: vendor?.dataProcessingAgreementId ?? '',
    dataLocation: vendor?.dataLocation ?? '',
    contractStartsOn: vendor?.contractStartsOn ?? '',
    contractEndsOn: vendor?.contractEndsOn ?? '',
    noticePeriodDays:
      vendor?.noticePeriodDays === null || vendor?.noticePeriodDays === undefined
        ? ''
        : String(vendor.noticePeriodDays),
  });
  const [error, setError] = useState('');

  const level = levels.data?.find((entry) => entry.code === form.criticality);
  /*
   * The agreement already on file, by NAME. Asked for the id the supplier arrived with rather than the
   * one in `form`, because the picker remembers the label of anything chosen in this session itself —
   * so this is one request for the one case the picker cannot name, and nothing on a fresh registration.
   */
  const agreementTitle = useDocumentTitle(vendor?.dataProcessingAgreementId);

  const mutation = useMutation({
    mutationFn: async () => {
      const body = {
        name: form.name,
        legalName: form.legalName || null,
        services: form.services,
        criticality: form.criticality,
        ownerId: form.ownerId,
        dataProcessor: form.dataProcessor,
        // Null, not omitted, when cleared: the API distinguishes "leave it alone" (absent) from
        // "there is no agreement" (null), and the second is the answer a correction has to be able to
        // give — the service refuses it on a live processor, which is the refusal we want surfaced
        // rather than a field that silently does nothing.
        dataProcessingAgreementId: form.dataProcessingAgreementId || null,
        dataLocation: form.dataLocation || null,
        contractStartsOn: form.contractStartsOn || null,
        contractEndsOn: form.contractEndsOn || null,
        noticePeriodDays: form.noticePeriodDays ? Number(form.noticePeriodDays) : null,
      };
      const { error: err } = editing
        ? await api.PATCH('/v1/vendors/{id}', { params: { path: { id: vendor.id } }, body })
        : await api.POST('/v1/vendors', { body: { ...body, reference: form.reference } });
      if (err)
        throw new Error(
          apiErrorMessage(
            err,
            editing ? 'Failed to correct the supplier.' : 'Failed to register the supplier.',
          ),
        );
    },
    onSuccess: () => {
      toast.success(editing ? 'Supplier updated' : 'Supplier registered');
      onSuccess();
      onClose();
    },
    onError: (e: Error) => setError(e.message),
  });

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? `Correct ${vendor.reference}` : 'Register a supplier'}
      description={
        editing
          ? 'Corrects the record only. The status, the review date and a termination are not editable here — each belongs to a decision with its own preconditions.'
          : 'Registered as PROSPECTIVE. Activating one is a separate decision, and a separate permission.'
      }
      // The field the correction was opened ON, when it came from a finding rather than a row action —
      // see `focus`. Only the agreement so far, because it is the only one a report points at.
      initialFocus={focus === 'dataProcessingAgreement' ? 'vendor-dpa' : undefined}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setError('');
          mutation.mutate();
        }}
        className="flex flex-col gap-4 p-5"
      >
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Reference" htmlFor="vendor-reference" required>
            <Input
              id="vendor-reference"
              required
              // Read-only when correcting: assessments, risk links, the review-gap report and the
              // unassessed-spend report all quote the reference, so changing it would orphan every
              // citation. `UpdateVendorSchema` omits it for exactly that reason, and a field the API
              // will not accept must not look editable.
              disabled={editing}
              value={form.reference}
              onChange={(e) => set('reference', e.target.value.toUpperCase())}
              placeholder="SUP-2026-014"
            />
          </FormField>
          <FormField label="Criticality" htmlFor="vendor-criticality" required>
            <Select
              id="vendor-criticality"
              value={form.criticality}
              onChange={(e) => set('criticality', e.target.value as typeof form.criticality)}
            >
              {CRITICALITIES.map((code) => (
                <option key={code} value={code}>
                  {levels.data?.find((entry) => entry.code === code)?.label ?? humanizeStatus(code)}
                </option>
              ))}
            </Select>
          </FormField>
        </div>

        {/* The schedule the choice commits to, from the reference table rather than restated here. */}
        {level && (
          <p className="-mt-2 text-xs text-fg-subtle">
            {level.description} Reassessed every {level.reviewIntervalMonths} months
            {level.requiresIndependentEvidence ? ', and independent evidence is required.' : '.'}
          </p>
        )}

        <div className="grid grid-cols-2 gap-3">
          <FormField label="Name" htmlFor="vendor-name" required>
            <Input
              id="vendor-name"
              required
              value={form.name}
              onChange={(e) => set('name', e.target.value)}
              placeholder="Acme Cloud"
            />
          </FormField>
          <FormField
            label="Legal name"
            htmlFor="vendor-legal"
            hint="If it differs from the trading name."
          >
            <Input
              id="vendor-legal"
              value={form.legalName}
              onChange={(e) => set('legalName', e.target.value)}
            />
          </FormField>
        </div>

        <FormField
          label="Services"
          htmlFor="vendor-services"
          required
          hint="What they do for us. This is what a continuity plan is written against."
        >
          <Textarea
            id="vendor-services"
            required
            rows={2}
            value={form.services}
            onChange={(e) => set('services', e.target.value)}
          />
        </FormField>

        <FormField label="Owner" htmlFor="vendor-owner" required>
          <EntityPicker
            id="vendor-owner"
            queryKey="active-employees"
            value={form.ownerId}
            onChange={(value) => set('ownerId', value)}
            fetchOptions={activeEmployeeOptions}
            // The owner the supplier already has, BY NAME. Without this a correction form opens with a
            // uuid in the field — the picker cannot know the label of a value it did not fetch, and the
            // row already carries the resolved name.
            selectedLabel={vendor?.ownerName ?? undefined}
            placeholder="Search people…"
          />
        </FormField>

        <div className="grid grid-cols-3 gap-3">
          <FormField label="Contract starts" htmlFor="vendor-start">
            <Input
              id="vendor-start"
              type="date"
              value={form.contractStartsOn}
              onChange={(e) => set('contractStartsOn', e.target.value)}
            />
          </FormField>
          <FormField label="Contract ends" htmlFor="vendor-end">
            <Input
              id="vendor-end"
              type="date"
              value={form.contractEndsOn}
              onChange={(e) => set('contractEndsOn', e.target.value)}
            />
          </FormField>
          <FormField label="Notice (days)" htmlFor="vendor-notice">
            <Input
              id="vendor-notice"
              type="number"
              min={0}
              value={form.noticePeriodDays}
              onChange={(e) => set('noticePeriodDays', e.target.value)}
            />
          </FormField>
        </div>

        <Checkbox
          align="start"
          checked={form.dataProcessor}
          onChange={(value) => set('dataProcessor', value)}
          label="Processes personal data on our behalf"
          hint="Makes them a processor under GDPR Article 28, which needs a data-processing agreement."
        />

        {form.dataProcessor && (
          <>
            {/*
              THE FIELD THE REGISTER SHOUTS ABOUT. `dataProcessingAgreementId` has always been settable
              on both `POST /v1/vendors` and `PATCH /v1/vendors/:id` and appeared in no form, while the
              row renders a red "No DPA" and the drawer says "Yes — NO DPA recorded". So the screen named
              a GDPR Article 28(3) gap that the product gave nobody a way to close.

              A PICKER, NOT A UUID BOX. The agreement is a controlled document, the same as an audit's
              report and a review's minutes, so it is chosen the same way and by the same source — which
              also means a retired document cannot be cited, because `documentOptions` excludes them.
            */}
            <FormField
              label="Data processing agreement"
              htmlFor="vendor-dpa"
              hint="The signed DPA, as a controlled document. Required before an active processor — GDPR Article 28(3)."
            >
              <EntityPicker
                id="vendor-dpa"
                queryKey="documents"
                value={form.dataProcessingAgreementId}
                onChange={(value) => set('dataProcessingAgreementId', value)}
                fetchOptions={documentOptions}
                // The agreement already on file, by name rather than by id — see `useDocumentTitle`.
                selectedLabel={agreementTitle.data ?? undefined}
                placeholder="Search documents…"
              />
            </FormField>
            <FormField
              label="Where the data is held"
              htmlFor="vendor-data-location"
              hint="The transfer question follows from this."
            >
              <Input
                id="vendor-data-location"
                value={form.dataLocation}
                onChange={(e) => set('dataLocation', e.target.value)}
                placeholder="EU (Frankfurt)"
              />
            </FormField>
          </>
        )}

        <FormError message={error} />

        <FormActions
          loading={mutation.isPending}
          onClose={onClose}
          submitLabel={editing ? 'Save correction' : 'Register supplier'}
        />
      </form>
    </Modal>
  );
}
