import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/shared/api/client';
import { apiErrorMessage } from '@/shared/api/errors';
import { activeEmployeeOptions } from '@/shared/api/picker-sources';
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
import {
  ASSET_TYPES,
  CIA_FACTORS,
  CLASSIFICATIONS,
  type ClassificationLevel,
  type InformationAsset,
} from './asset.types';
import { useClassificationLevels } from './use-assets';

/**
 * Registering, correcting and reclassifying an information asset.
 *
 * CLASSIFYING NEEDS A REASON, at registration and at every change afterwards. The API appends a history
 * row per change, so the register answers "when did this become restricted, and who said so" rather than
 * only "what is it now" — and a reason nobody wrote is the gap that makes that history useless.
 *
 * DECLASSIFYING IS A DIFFERENT PERMISSION (`information_asset.declassify`, not `.manage`), because
 * lowering a classification removes protection. The screen sends it to a different endpoint for that
 * reason, and the caller who cannot do it does not see the option.
 *
 * CORRECTING IS THE THIRD ACT, and it is what makes the second one reachable. `RegisterAssetModal`
 * serves both verbs — see its `asset` prop for why the register was append-only by accident, and why
 * an asset registered `internal` with a confidentiality of 3 could never be reclassified `restricted`
 * from the product at all until this form offered the CIA rating.
 */

/** The handling rules for a level, from the API's own reference table rather than restated here. */
/** The policy's own handling rules for a level. Shared with the reclassify dialog. */
export function LevelRules({ level }: { level: ClassificationLevel | undefined }) {
  if (!level) return null;
  return (
    <p className="-mt-2 text-xs text-fg-subtle">
      {level.handlingRules}
      {level.encryptionRequired && (
        <span className="ml-1 font-medium text-warning">Encryption required.</span>
      )}
    </p>
  );
}

export function RegisterAssetModal({
  open,
  onClose,
  onSuccess,
  asset,
}: {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
  /**
   * Present to CORRECT an existing entry rather than register a new one.
   *
   * WHY THIS MODE EXISTS. `PATCH /v1/information-assets/:id` has been there since the module was
   * written and no screen called it, so the register was append-only by accident: a wrong owner, a
   * mis-rated asset or a location that moved stayed wrong for ever, and the only way out was to
   * retire the entry and register a new one — which loses the classification history that is the
   * whole point of keeping a register.
   *
   * AND IT UNBLOCKS A DEAD END. `reclassify` judges the NEW label against the CIA rating already
   * stored, and the API refuses `restricted` on anything rated below 4 for confidentiality — "the
   * label was applied without the assessment agreeing". This `PATCH` is the only route that can move
   * a rating. So an asset registered `internal` with a confidentiality of 3 could never become
   * `restricted` from the product at all: the reclassify dialog 412'd and there was no screen to
   * raise the rating first. The CIA fields below are that screen.
   *
   * `UpdateInformationAssetSchema` is the register schema minus the reference and minus the
   * classification, all optional — so the same form serves both verbs.
   */
  asset?: InformationAsset;
}) {
  const editing = !!asset;
  const levels = useClassificationLevels();
  const [form, setForm] = useState({
    reference: asset?.reference ?? '',
    name: asset?.name ?? '',
    description: asset?.description ?? '',
    type: (asset?.type ?? 'dataset') as (typeof ASSET_TYPES)[number],
    classification: (asset?.classification ?? 'internal') as (typeof CLASSIFICATIONS)[number],
    classificationReason: '',
    ownerId: asset?.ownerId ?? '',
    custodianId: asset?.custodianId ?? '',
    confidentiality: String(asset?.confidentiality ?? 3),
    integrity: String(asset?.integrity ?? 3),
    availability: String(asset?.availability ?? 3),
    personalData: asset?.personalData ?? false,
    location: asset?.location ?? '',
    retentionMonths: asset?.retentionMonths != null ? String(asset.retentionMonths) : '',
    reviewDueOn: asset?.reviewDueOn ?? '',
  });
  const [error, setError] = useState('');

  const chosenLevel = levels.data?.find((level) => level.code === form.classification);

  const mutation = useMutation({
    mutationFn: async () => {
      /*
       * `classification` and `classificationReason` are NOT in here, and that is the point of the
       * split rather than an oversight: the schema omits both, because changing a label appends a
       * history row and, downwards, needs `information_asset.declassify`. Sending it from a generic
       * correction would make an audited act depend on which form somebody happened to open.
       */
      const body = {
        name: form.name,
        description: form.description || null,
        type: form.type,
        ownerId: form.ownerId,
        custodianId: form.custodianId || null,
        confidentiality: Number(form.confidentiality),
        integrity: Number(form.integrity),
        availability: Number(form.availability),
        personalData: form.personalData,
        location: form.location || null,
        retentionMonths: form.retentionMonths ? Number(form.retentionMonths) : null,
        reviewDueOn: form.reviewDueOn || null,
      };
      const { error: err } = editing
        ? await api.PATCH('/v1/information-assets/{id}', {
            params: { path: { id: asset.id } },
            body,
          })
        : await api.POST('/v1/information-assets', {
            body: {
              ...body,
              reference: form.reference,
              classification: form.classification,
              classificationReason: form.classificationReason,
            },
          });
      if (err)
        throw new Error(
          apiErrorMessage(
            err,
            editing ? 'Failed to correct the asset.' : 'Failed to register the asset.',
          ),
        );
    },
    onSuccess: () => {
      toast.success(editing ? 'Information asset corrected' : 'Information asset registered');
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
      title={editing ? `Correct ${asset.reference}` : 'Register an information asset'}
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
          <FormField label="Reference" htmlFor="asset-reference" required>
            <Input
              id="asset-reference"
              required
              // Read-only when correcting. Risk assessments, audit findings and the classification
              // history all quote the reference, so changing it would orphan every citation —
              // `UpdateInformationAssetSchema` omits it for that reason rather than making it
              // optional.
              disabled={editing}
              value={form.reference}
              onChange={(e) => set('reference', e.target.value.toUpperCase())}
              placeholder="IA-2026-014"
            />
          </FormField>
          <FormField label="Type" htmlFor="asset-type" required>
            <Select
              id="asset-type"
              value={form.type}
              onChange={(e) => set('type', e.target.value as typeof form.type)}
            >
              {ASSET_TYPES.map((type) => (
                <option key={type} value={type}>
                  {humanizeStatus(type)}
                </option>
              ))}
            </Select>
          </FormField>
        </div>

        <FormField label="Name" htmlFor="asset-name" required>
          <Input
            id="asset-name"
            required
            value={form.name}
            onChange={(e) => set('name', e.target.value)}
            placeholder="Customer billing database"
          />
        </FormField>

        <FormField
          label="Description"
          htmlFor="asset-description"
          hint="What is actually in it. Read by whoever has to decide, during an incident, whether this one matters."
        >
          <Textarea
            id="asset-description"
            rows={2}
            value={form.description}
            onChange={(e) => set('description', e.target.value)}
          />
        </FormField>

        {/*
          CLASSIFICATION IS OFFERED ONLY WHEN REGISTERING.

          `UpdateInformationAssetSchema` omits `classification` AND `classificationReason`, and the
          correction form must not work around that. Changing a label is an audited act: it appends a
          row to the asset's classification history with the reason, and LOWERING it needs
          `information_asset.declassify` rather than `.manage`. A label moved through a generic patch
          would leave a history that cannot account for the current classification, which is the one
          thing the register exists to do. The Reclassify action is the way to change it — the note
          below points there rather than leaving the reader to wonder where the field went.
        */}
        {editing ? (
          <p className="text-xs text-fg-subtle">
            Classified{' '}
            <span className="font-medium text-fg">
              {chosenLevel?.label ?? humanizeStatus(form.classification)}
            </span>
            . Changing that is a reclassification: it needs a reason, it is appended to the asset’s
            history, and lowering it needs a separate permission — so it lives behind the{' '}
            <span className="font-medium text-fg">Reclassify</span> action, not here.
          </p>
        ) : (
          <>
            <FormField label="Classification" htmlFor="asset-classification" required>
              <Select
                id="asset-classification"
                value={form.classification}
                onChange={(e) =>
                  set('classification', e.target.value as typeof form.classification)
                }
              >
                {CLASSIFICATIONS.map((code) => (
                  <option key={code} value={code}>
                    {levels.data?.find((level) => level.code === code)?.label ??
                      humanizeStatus(code)}
                  </option>
                ))}
              </Select>
            </FormField>
            {/* The policy's own handling rules, shown where the choice is made. */}
            <LevelRules level={chosenLevel} />

            <FormField
              label="Why this classification"
              htmlFor="asset-reason"
              required
              hint="Kept as the first entry in the asset's classification history."
            >
              <Textarea
                id="asset-reason"
                required
                rows={2}
                value={form.classificationReason}
                onChange={(e) => set('classificationReason', e.target.value)}
              />
            </FormField>
          </>
        )}

        {/* OWNER decides the classification; CUSTODIAN operates the controls day to day. Two
            different accountabilities, which is why the API keeps them apart and the drawer prints
            them one under the other — and why the custodian is offered here rather than being a
            field only the API could ever set. */}
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Owner" htmlFor="asset-owner" required>
            <EntityPicker
              id="asset-owner"
              queryKey="active-employees"
              value={form.ownerId}
              onChange={(value) => set('ownerId', value)}
              fetchOptions={activeEmployeeOptions}
              // The name the API already resolved. Without it a pre-filled picker can only show the
              // raw uuid, because the label lives in a response this picker has not fetched.
              selectedLabel={asset?.ownerName ?? undefined}
              placeholder="Search people…"
            />
          </FormField>
          <FormField label="Custodian" htmlFor="asset-custodian" hint="Optional.">
            <EntityPicker
              id="asset-custodian"
              queryKey="active-employees"
              value={form.custodianId}
              onChange={(value) => set('custodianId', value)}
              fetchOptions={activeEmployeeOptions}
              selectedLabel={asset?.custodianName ?? undefined}
              placeholder="Search people…"
            />
          </FormField>
        </div>

        {/* THREE RATINGS, NOT ONE SCORE. A public dataset can still be availability-critical, and
            combining them would throw away exactly that distinction.

            OFFERED WHEN CORRECTING TOO, and that is the whole reason this form has two verbs. The
            reclassify route judges the new label against the rating ALREADY STORED — `restricted`
            needs confidentiality of at least 4, `public` demands exactly 1 — and this patch is the
            only route that can move a rating. Without these fields here, an asset registered
            `internal` at 3 was permanently stuck below `restricted`.

            Nothing here pre-empts those rules by filtering the options: the API's refusal names the
            label and the number it wanted, and a form that quietly hid the incoherent combination
            would teach nobody why it is incoherent. */}
        <fieldset className="grid grid-cols-3 gap-3">
          <legend className="mb-1.5 text-xs font-medium text-fg-muted">
            Confidentiality · integrity · availability (1–5)
          </legend>
          {(['confidentiality', 'integrity', 'availability'] as const).map((field) => (
            <FormField
              key={field}
              label={humanizeStatus(field)}
              htmlFor={`asset-${field}`}
              required
            >
              <Select
                id={`asset-${field}`}
                value={form[field]}
                onChange={(e) => set(field, e.target.value)}
              >
                {CIA_FACTORS.map((factor) => (
                  <option key={factor} value={factor}>
                    {factor}
                  </option>
                ))}
              </Select>
            </FormField>
          ))}
        </fieldset>

        <div className="grid grid-cols-2 gap-3">
          <FormField label="Location" htmlFor="asset-location" hint="Where it lives.">
            <Input
              id="asset-location"
              value={form.location}
              onChange={(e) => set('location', e.target.value)}
              placeholder="eu-west-1 / RDS"
            />
          </FormField>
          <FormField
            label="Retention (months)"
            htmlFor="asset-retention"
            hint="Empty means no retention period recorded."
          >
            <Input
              id="asset-retention"
              type="number"
              min={1}
              value={form.retentionMonths}
              onChange={(e) => set('retentionMonths', e.target.value)}
            />
          </FormField>
        </div>

        {/* The next review. Movable here because "Reviewed" deliberately does NOT rewrite the
            schedule — it stamps today and leaves the date alone, so changing the schedule has to be
            an edit somewhere, and this is it. */}
        <FormField
          label="Review due"
          htmlFor="asset-review-due"
          hint="Empty means no review scheduled."
        >
          <Input
            id="asset-review-due"
            type="date"
            value={form.reviewDueOn}
            onChange={(e) => set('reviewDueOn', e.target.value)}
          />
        </FormField>

        {/* Left tickable at every classification ON PURPOSE. The API refuses personal data on
            anything below `confidential`, and its refusal names the level it wants; disabling the box
            on an `internal` asset would present the same rule as "this field does not apply here",
            which is a different and wrong statement. */}
        <Checkbox
          align="start"
          checked={form.personalData}
          onChange={(value) => set('personalData', value)}
          label="Holds personal data"
          hint="Brings it into the GDPR register, and into the breach assessment when an incident touches it."
        />

        <FormError message={error} />

        <FormActions
          loading={mutation.isPending}
          onClose={onClose}
          submitLabel={editing ? 'Save correction' : 'Register asset'}
        />
      </form>
    </Modal>
  );
}
