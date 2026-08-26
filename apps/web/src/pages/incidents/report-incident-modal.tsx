import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/shared/api/client';
import { apiErrorMessage } from '@/shared/api/errors';
import { assetOptions, riskOptions } from '@/shared/api/picker-sources';
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
import { BREACH_NOTIFICATION_HOURS, SEVERITIES } from './incident.types';
import type { Incident } from './incident.types';

/**
 * An instant as a `datetime-local` value, in the reader's own zone — the inverse of what that field sends.
 *
 * MINUTE PRECISION IS WHY A CORRECTION ONLY SENDS `detectedAt` WHEN IT MOVED. The control cannot
 * represent seconds, so a detection recorded at 09:14:37 comes back out of it as 09:14, and re-sending
 * that on a correction which was only ever about the severity would quietly move the instant every
 * deadline in this module counts from — including the 72-hour one with a regulator on the other end.
 */
function toLocalInput(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  return new Date(at.getTime() - at.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

/**
 * Report an incident — or CORRECT one that has already been reported.
 *
 * REPORTING NEEDS NO PERMISSION, deliberately: anybody who notices something must be able to raise it,
 * and `incident.manage` governs the handling. So this form is the one part of the screen that is never
 * gated, and the action stays on the page for every reader.
 *
 * `detectedAt` IS WHEN SOMEBODY BECAME AWARE, not when the incident happened — and it is the input the
 * breach clock runs from, so the field says so. `datetime-local`, because the difference between 09:00
 * and 17:00 on the same day is a third of the 72 hours.
 *
 * ONE FORM, TWO VERBS. `UpdateIncidentSchema` IS this form's schema minus the reference with everything
 * optional, so a second form would be the same fields, the same hints and the same severity vocabulary
 * maintained twice — and the pair would drift on exactly the field a correction is usually about.
 */
export function ReportIncidentModal({
  open,
  onClose,
  onSuccess,
  incident,
}: {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
  /**
   * Present to CORRECT an incident already in the register rather than report a new one.
   *
   * WHY THIS MODE EXISTS. `PATCH /v1/incidents/:id` has been there since the module was written and no
   * screen called it, so the register was append-only by accident: a severity graded in the first ten
   * minutes of a response, a `personalDataBreach` ticked by somebody being careful, a category typed
   * wrong — all permanent. The only ways out were to close the incident and report a duplicate, which
   * breaks the reference every report and regulator letter quotes, or to leave the record wrong and
   * explain it in a timeline note nobody filters on.
   *
   * Severity is the one that costs most. It drives the response queue's ordering, so a `low` that was
   * really `critical` sinks to the bottom of the list the responders read.
   */
  incident?: Incident;
}) {
  const editing = !!incident;
  /** What the API holds, in the field's own format — the baseline the "did it move" test compares to. */
  const detectionAsRecorded = incident ? toLocalInput(incident.detectedAt) : '';
  const [form, setForm] = useState({
    reference: incident?.reference ?? '',
    title: incident?.title ?? '',
    description: incident?.description ?? '',
    category: incident?.category ?? '',
    severity: (incident?.severity ?? 'medium') as (typeof SEVERITIES)[number],
    detectedAt: detectionAsRecorded,
    personalDataBreach: incident?.personalDataBreach ?? false,
    riskId: incident?.riskId ?? '',
    assetId: incident?.assetId ?? '',
  });
  const [error, setError] = useState('');

  const mutation = useMutation({
    mutationFn: async () => {
      /** Shared by both verbs, because both schemas contain exactly these. */
      const shared = {
        title: form.title,
        description: form.description,
        category: form.category,
        severity: form.severity,
        personalDataBreach: form.personalDataBreach,
      };
      const { error: err } = incident
        ? await api.PATCH('/v1/incidents/{id}', {
            params: { path: { id: incident.id } },
            body: {
              ...shared,
              // NO `reference`: `UpdateIncidentSchema` omits it, so sending one would be silently
              // dropped rather than honoured — and the field is disabled below for the same reason.
              //
              // `detectedAt` ONLY IF IT MOVED — see `toLocalInput`. It is also the field the service
              // guards hardest (a detection dragged past a recorded containment or into the future is
              // refused by name), and those refusals are not pre-empted here: the API's message names
              // the timestamp that blocks it, which is more than a client-side rule could say.
              ...(form.detectedAt === detectionAsRecorded
                ? {}
                : { detectedAt: new Date(form.detectedAt).toISOString() }),
              // `null`, not omitted, when nothing is chosen: these links must be REMOVABLE and not
              // merely replaceable — a risk linked to the wrong incident is the reverse of the gap
              // this closes, and omitting the key would leave it there for ever.
              riskId: form.riskId || null,
              assetId: form.assetId || null,
            },
          })
        : await api.POST('/v1/incidents/report', {
            body: {
              ...shared,
              reference: form.reference,
              detectedAt: new Date(form.detectedAt).toISOString(),
            },
          });
      if (err)
        throw new Error(
          apiErrorMessage(
            err,
            editing ? 'Failed to correct the incident.' : 'Failed to report the incident.',
          ),
        );
    },
    onSuccess: () => {
      toast.success(editing ? 'Incident corrected' : 'Incident reported');
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
      title={incident ? `Correct ${incident.reference}` : 'Report an incident'}
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
          <FormField label="Reference" htmlFor="incident-reference" required>
            <Input
              id="incident-reference"
              required
              // Read-only when correcting: the post-incident report, the breach notification and any
              // regulator correspondence all quote this, so changing it would orphan every citation —
              // which is why `UpdateIncidentSchema` omits the field rather than making it optional.
              disabled={editing}
              value={form.reference}
              onChange={(e) => set('reference', e.target.value.toUpperCase())}
              placeholder="INC-2026-014"
            />
          </FormField>
          <FormField label="Category" htmlFor="incident-category" required>
            <Input
              id="incident-category"
              required
              value={form.category}
              onChange={(e) => set('category', e.target.value)}
              placeholder="Phishing"
            />
          </FormField>
        </div>

        <FormField label="Title" htmlFor="incident-title" required>
          <Input
            id="incident-title"
            required
            value={form.title}
            onChange={(e) => set('title', e.target.value)}
            placeholder="Credential-harvesting email opened by two people in Finance"
          />
        </FormField>

        <FormField
          label="What happened"
          htmlFor="incident-description"
          required
          hint="Written for somebody reading it cold, weeks later, possibly a regulator."
        >
          <Textarea
            id="incident-description"
            required
            rows={4}
            value={form.description}
            onChange={(e) => set('description', e.target.value)}
          />
        </FormField>

        <div className="grid grid-cols-2 gap-3">
          <FormField label="Severity" htmlFor="incident-severity" required>
            <Select
              id="incident-severity"
              value={form.severity}
              onChange={(e) => set('severity', e.target.value as typeof form.severity)}
            >
              {SEVERITIES.map((severity) => (
                <option key={severity} value={severity}>
                  {humanizeStatus(severity)}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField
            label="Detected at"
            htmlFor="incident-detected"
            required
            hint={
              editing
                ? 'When somebody became AWARE. Moving it moves the breach deadline with it, and it cannot pass a containment already recorded.'
                : 'When somebody became AWARE. The breach clock runs from this.'
            }
          >
            <Input
              id="incident-detected"
              type="datetime-local"
              required
              value={form.detectedAt}
              onChange={(e) => set('detectedAt', e.target.value)}
            />
          </FormField>
        </div>

        {/*
          THE LINKS, ONLY WHEN CORRECTING. `assetId` and `riskId` are in both schemas and were in no
          form, so an incident could never be traced to the risk it realised — which is the ISMS's whole
          feedback loop, and what `/incidents/unlinked-to-risk` exists to chase.

          Not offered while REPORTING, for two reasons that point the same way. Reporting is ungated by
          design, while these option lists come from `/v1/risks` and `/v1/assets` and need `risk.read`
          and `asset.read` — so the person the ungated form exists for would meet two empty boxes. And
          the answer is not theirs to give: "which register risk did this realise" is a triage judgement
          made by somebody holding the register, minutes or days after the report.
        */}
        {editing && (
          <div className="grid grid-cols-2 gap-3">
            <FormField
              label="Linked risk"
              htmlFor="incident-risk"
              hint="The register entry this incident realised, when there was one."
            >
              <EntityPicker
                id="incident-risk"
                queryKey="risks"
                value={form.riskId}
                onChange={(value) => set('riskId', value)}
                fetchOptions={riskOptions}
                placeholder="Search the register…"
              />
            </FormField>
            <FormField
              label="Affected device"
              htmlFor="incident-asset"
              hint="The machine it happened on, if it was one machine."
            >
              <EntityPicker
                id="incident-asset"
                queryKey="assets"
                value={form.assetId}
                onChange={(value) => set('assetId', value)}
                fetchOptions={assetOptions}
                placeholder="Search by tag or serial…"
              />
            </FormField>
          </div>
        )}

        {/* A real checkbox with a real label, because this one flag starts a legal deadline. The hint
            is inside the same label, so the consequence is part of the accessible name rather than
            text sitting beside the control. */}
        <Checkbox
          align="start"
          checked={form.personalDataBreach}
          onChange={(value) => set('personalDataBreach', value)}
          // LOCKED ONCE THE REGULATOR HAS BEEN TOLD, and this is a hole the API does not close:
          // `UpdateIncidentSchema` will happily un-tick the flag, which would drop the incident off the
          // breach report and out of the 72-hour arithmetic while `regulatorNotifiedAt` still records
          // that a regulator was notified about a breach — a record contradicting itself, and no route
          // exists to un-notify. Correcting a wrongly-ticked breach is exactly what this mode is for, so
          // it stays available right up to the notification and stops there.
          disabled={!!incident?.regulatorNotifiedAt}
          label="Personal data was or may have been exposed"
          hint={
            incident?.regulatorNotifiedAt
              ? 'The regulator has already been notified, so this can no longer be withdrawn — the notification is the record that the obligation was met.'
              : `Starts the ${BREACH_NOTIFICATION_HOURS}-hour notification clock (GDPR Article 33). The deadline is computed by the API from the detection time.`
          }
        />

        <FormError message={error} />

        <FormActions
          loading={mutation.isPending}
          onClose={onClose}
          submitLabel={editing ? 'Save correction' : 'Report incident'}
        />
      </form>
    </Modal>
  );
}
