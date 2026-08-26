import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/shared/api/client';
import { apiErrorMessage } from '@/shared/api/errors';
import { FormActions, FormError, FormField, Input, Modal } from '@/shared/ui';
import type { FormModalProps } from '@/shared/ui';

/**
 * Create a review cycle.
 *
 * A cycle is created as a DRAFT and opened separately, which is why this form has no status field.
 * Opening it is the act that lets reviews be created: `createReview` refuses any cycle that is not
 * open, and the coverage report on the drawer is how somebody checks who is missing once it is. This
 * docblock used to say a draft "is where reviews are created and reviewers assigned", which the
 * service has never allowed — and the cycles table offered the action on drafts on the strength of it,
 * so the save was refused by a rule no screen mentioned.
 *
 * SELF-ASSESSMENT IS OPTIONAL, and its absence is a real answer — a cycle can go straight to the
 * manager's write-up. The field is left empty rather than defaulted to the review date, because a
 * self-assessment due the same day as the review is not a deadline, it is a formality.
 */
export function CreateCycleModal({ open, onClose, onSuccess }: FormModalProps) {
  const [form, setForm] = useState({
    reference: '',
    name: '',
    periodStart: '',
    periodEnd: '',
    selfAssessmentDue: '',
    reviewDue: '',
  });
  const [error, setError] = useState('');

  const mutation = useMutation({
    mutationFn: async () => {
      const { error: err } = await api.POST('/v1/performance/cycles', {
        body: {
          reference: form.reference,
          name: form.name,
          periodStart: form.periodStart,
          periodEnd: form.periodEnd,
          selfAssessmentDue: form.selfAssessmentDue || null,
          reviewDue: form.reviewDue,
        },
      });
      // The API names the rule it refused on — a duplicate reference, a period that runs backwards, a
      // review date before the period ends. Guessing here would only ever be less specific.
      if (err) throw new Error(apiErrorMessage(err, 'Failed to create the cycle.'));
    },
    onSuccess: () => {
      toast.success('Cycle created');
      onSuccess();
      onClose();
    },
    onError: (e: Error) => setError(e.message),
  });

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  return (
    <Modal open={open} onClose={onClose} title="New review cycle">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setError('');
          mutation.mutate();
        }}
        className="flex flex-col gap-4 p-5"
      >
        <div className="grid grid-cols-2 gap-3">
          <FormField
            label="Reference"
            htmlFor="cycle-reference"
            required
            hint="Quoted in HR records. Cannot be changed later."
          >
            <Input
              id="cycle-reference"
              required
              value={form.reference}
              onChange={(e) => set('reference', e.target.value.toUpperCase())}
              placeholder="FY26-H1"
            />
          </FormField>
          <FormField label="Name" htmlFor="cycle-name" required>
            <Input
              id="cycle-name"
              required
              value={form.name}
              onChange={(e) => set('name', e.target.value)}
              placeholder="FY26 mid-year review"
            />
          </FormField>
        </div>

        <fieldset className="grid grid-cols-2 gap-3">
          <legend className="mb-1.5 text-xs font-medium text-fg-muted">Period under review</legend>
          <FormField label="From" htmlFor="cycle-start" required>
            <Input
              id="cycle-start"
              type="date"
              required
              value={form.periodStart}
              onChange={(e) => set('periodStart', e.target.value)}
            />
          </FormField>
          <FormField label="To" htmlFor="cycle-end" required>
            <Input
              id="cycle-end"
              type="date"
              required
              value={form.periodEnd}
              onChange={(e) => set('periodEnd', e.target.value)}
            />
          </FormField>
        </fieldset>

        <div className="grid grid-cols-2 gap-3">
          <FormField
            label="Self-assessment due"
            htmlFor="cycle-self-due"
            hint="Leave empty for a cycle with no self-assessment step."
          >
            <Input
              id="cycle-self-due"
              type="date"
              value={form.selfAssessmentDue}
              onChange={(e) => set('selfAssessmentDue', e.target.value)}
            />
          </FormField>
          <FormField label="Review due" htmlFor="cycle-review-due" required>
            <Input
              id="cycle-review-due"
              type="date"
              required
              value={form.reviewDue}
              onChange={(e) => set('reviewDue', e.target.value)}
            />
          </FormField>
        </div>

        <FormError message={error} />

        <FormActions loading={mutation.isPending} onClose={onClose} submitLabel="Create cycle" />
      </form>
    </Modal>
  );
}
