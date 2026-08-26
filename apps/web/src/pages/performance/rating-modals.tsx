import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/shared/api/client';
import { apiErrorMessage } from '@/shared/api/errors';
import { FormActions, FormError, FormField, Input, Modal, Select, Textarea } from '@/shared/ui';
import { useRatingScale, useReviewGoals } from './use-performance';
import { GoalGradingFieldset } from './goal-grading-fieldset';
import type { Review } from './performance.types';

/**
 * The forms that WRITE a review: the employee's account, the reviewer's rating, a cancellation, and a
 * goal.
 *
 * These are the reviewer's and the subject's own acts — no permission code is involved, only being the
 * person named on the row. Kept apart from `review-modals.tsx`, which is where a review is created and
 * reassigned by somebody holding `performance.manage`.
 */

/** The employee's own account of the period. Their words, submitted once. */
export function SelfAssessmentModal({
  review,
  onClose,
  onSuccess,
}: {
  review: Review;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [selfAssessment, setSelfAssessment] = useState(review.selfAssessment ?? '');
  const [error, setError] = useState('');

  const mutation = useMutation({
    mutationFn: async () => {
      const { error: err } = await api.POST('/v1/performance/reviews/{id}/self-assessment', {
        params: { path: { id: review.id } },
        body: { selfAssessment },
      });
      if (err) throw new Error(apiErrorMessage(err, 'Failed to submit your self-assessment.'));
    },
    onSuccess: () => {
      toast.success('Self-assessment submitted');
      onSuccess();
      onClose();
    },
    onError: (e: Error) => setError(e.message),
  });

  return (
    <Modal
      open
      onClose={onClose}
      title="Your self-assessment"
      description="Submitting moves the review to your reviewer. They see what you wrote."
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
          label="What you did, and how it went"
          htmlFor="self-assessment"
          required
          hint="Your own account of the period under review."
        >
          <Textarea
            id="self-assessment"
            required
            rows={8}
            value={selfAssessment}
            onChange={(e) => setSelfAssessment(e.target.value)}
            placeholder="The work I am most pleased with…"
          />
        </FormField>

        <FormError message={error} />

        <FormActions loading={mutation.isPending} onClose={onClose} submitLabel="Submit" />
      </form>
    </Modal>
  );
}

/**
 * The reviewer's summary and rating.
 *
 * THE DEVELOPMENT PLAN IS CONDITIONALLY REQUIRED, and the condition comes from the API's rating scale
 * (`requiresDevelopmentPlan`) rather than from a list of "bad" ratings written here. That is the point of
 * the flag being on the reference table: change which ratings demand a plan and both the API and this
 * form follow. The field becomes required and says why, instead of the save failing with a rule the
 * form never mentioned.
 */
export function RateReviewModal({
  review,
  onClose,
  onSuccess,
}: {
  review: Review;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const scale = useRatingScale();
  const goals = useReviewGoals(review.id);
  const [managerSummary, setManagerSummary] = useState(review.managerSummary ?? '');
  const [overallRating, setOverallRating] = useState(review.overallRating ?? '');
  const [developmentPlan, setDevelopmentPlan] = useState(review.developmentPlan ?? '');
  const [error, setError] = useState('');
  /*
   * A GRADE AND AN OUTCOME PER GOAL, and the reason this form needs them at all: `POST /rating` has
   * always accepted `goals: [{ id, rating, outcome }]` and this modal never sent the field. Nothing
   * else can set a goal's grade — `SetGoalSchema` has no rating — so every goal stayed ungraded, and
   * `assertGoalsComplete` refuses to submit a review with an ungraded goal. A review with one goal on
   * it could therefore never leave the reviewer's desk, and the confirmation dialog on "Send for
   * approval" named the rule while offering no way to satisfy it.
   *
   * Keyed by goal id and seeded from what is already saved, so reopening the form shows the grades
   * rather than blanking them.
   */
  const [goalGrades, setGoalGrades] = useState<Record<string, { rating: string; outcome: string }>>(
    {},
  );

  /*
   * The values to SEND: the edits merged over what is already saved. Falling back to the saved grade
   * matters — a reviewer who opens the form, changes the summary and saves must not blank the grades
   * they set last time.
   */
  const graded = (goals.data ?? []).map((goal) => ({
    goal,
    value: goalGrades[goal.id] ?? { rating: goal.rating ?? '', outcome: goal.outcome ?? '' },
  }));

  const level = scale.data?.find((l) => l.code === overallRating);
  const planRequired = level?.requiresDevelopmentPlan ?? false;

  const mutation = useMutation({
    mutationFn: async () => {
      const { error: err } = await api.POST('/v1/performance/reviews/{id}/rating', {
        params: { path: { id: review.id } },
        body: {
          managerSummary,
          overallRating: overallRating as never,
          developmentPlan: developmentPlan || null,
          /*
           * Only the goals that HAVE a grade. Sending `rating: ''` would fail the enum, and sending
           * every goal with a null grade would overwrite grades already saved with nothing.
           */
          goals: graded
            .filter((g) => g.value.rating)
            .map((g) => ({
              id: g.goal.id,
              rating: g.value.rating as never,
              outcome: g.value.outcome || null,
            })),
        },
      });
      if (err) throw new Error(apiErrorMessage(err, 'Failed to save the rating.'));
    },
    onSuccess: () => {
      toast.success('Rating saved');
      onSuccess();
      onClose();
    },
    onError: (e: Error) => setError(e.message),
  });

  return (
    <Modal
      open
      onClose={onClose}
      title="Rate this review"
      description="Saved as a draft on the review. Sending it for approval is a separate step."
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setError('');
          mutation.mutate();
        }}
        className="flex flex-col gap-4 p-5"
      >
        {/* Goals are graded BEFORE the overall, because the overall is meant to be traceable to
            them — which is why the API refuses to submit a review whose goals are ungraded. */}
        <GoalGradingFieldset
          goals={goals.data ?? []}
          scale={scale.data ?? []}
          values={goalGrades}
          onChange={(goalId, next) => setGoalGrades((current) => ({ ...current, [goalId]: next }))}
        />

        <FormField label="Overall rating" htmlFor="rate-overall" required>
          <Select
            id="rate-overall"
            required
            value={overallRating}
            onChange={(e) => setOverallRating(e.target.value)}
          >
            <option value="">Choose a rating…</option>
            {(scale.data ?? []).map((option) => (
              <option key={option.code} value={option.code}>
                {option.label}
              </option>
            ))}
          </Select>
        </FormField>

        {/* The scale's own description of the level chosen — the definition the reviewer is applying,
            shown where they apply it rather than in a policy document nobody opens. */}
        {level && <p className="-mt-2 text-xs text-fg-subtle">{level.description}</p>}

        <FormField label="Summary" htmlFor="rate-summary" required>
          <Textarea
            id="rate-summary"
            required
            rows={6}
            value={managerSummary}
            onChange={(e) => setManagerSummary(e.target.value)}
            placeholder="What went well, what did not, and the evidence for both…"
          />
        </FormField>

        <FormField
          label="Development plan"
          htmlFor="rate-plan"
          required={planRequired}
          hint={
            planRequired
              ? 'Required for this rating: a poor rating with nothing attached is a complaint rather than a decision about what happens next.'
              : 'Optional for this rating.'
          }
        >
          <Textarea
            id="rate-plan"
            required={planRequired}
            rows={4}
            value={developmentPlan}
            onChange={(e) => setDevelopmentPlan(e.target.value)}
            placeholder="What support, training or change happens next…"
          />
        </FormField>

        <FormError message={error} />

        <FormActions loading={mutation.isPending} onClose={onClose} submitLabel="Save rating" />
      </form>
    </Modal>
  );
}

/** Cancel a review, which needs a reason — the record keeps it. */
export function CancelReviewModal({
  review,
  onClose,
  onSuccess,
}: {
  review: Review;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');

  const mutation = useMutation({
    mutationFn: async () => {
      const { error: err } = await api.POST('/v1/performance/reviews/{id}/cancel', {
        params: { path: { id: review.id } },
        body: { reason },
      });
      if (err) throw new Error(apiErrorMessage(err, 'Failed to cancel the review.'));
    },
    onSuccess: () => {
      toast.success('Review cancelled');
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
      title="Cancel this review"
      description="It stops counting towards the cycle, and shows on the coverage report as unreviewed."
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
          label="Reason"
          htmlFor="cancel-reason"
          required
          hint="Required by the API — somebody will ask later why this person was not reviewed."
        >
          <Textarea
            id="cancel-reason"
            required
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Employee left before the cycle closed…"
          />
        </FormField>

        <FormError message={error} />

        <FormActions
          loading={mutation.isPending}
          onClose={onClose}
          submitLabel="Cancel review"
          variant="danger"
        />
      </form>
    </Modal>
  );
}

/**
 * Add a goal to a review.
 *
 * WEIGHT IS A SHARE OF THE JUDGEMENT, and the set must total 100 before the review can go for approval
 * — a sum across rows, so no CHECK can see it and the API enforces it at submit. The panel that hosts
 * this form shows the running total, so nobody meets the rule for the first time at the moment they try
 * to submit.
 */
export function SetGoalModal({
  reviewId,
  remainingWeight,
  onClose,
  onSuccess,
}: {
  reviewId: string;
  /** What is left of the 100 — offered as the default, because it is almost always the answer. */
  remainingWeight: number;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [form, setForm] = useState({
    title: '',
    description: '',
    target: '',
    weight: remainingWeight > 0 ? String(remainingWeight) : '',
  });
  const [error, setError] = useState('');

  const mutation = useMutation({
    mutationFn: async () => {
      const { error: err } = await api.POST('/v1/performance/reviews/{id}/goals', {
        params: { path: { id: reviewId } },
        body: {
          title: form.title,
          description: form.description || null,
          target: form.target || null,
          weight: Number(form.weight),
        },
      });
      if (err) throw new Error(apiErrorMessage(err, 'Failed to save the goal.'));
    },
    onSuccess: () => {
      toast.success('Goal saved');
      onSuccess();
      onClose();
    },
    onError: (e: Error) => setError(e.message),
  });

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  return (
    <Modal open onClose={onClose} size="sm" title="Add a goal">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setError('');
          mutation.mutate();
        }}
        className="flex flex-col gap-4 p-5"
      >
        <FormField label="Goal" htmlFor="goal-title" required>
          <Input
            id="goal-title"
            required
            value={form.title}
            onChange={(e) => set('title', e.target.value)}
            placeholder="Ship the reporting rewrite"
          />
        </FormField>

        <FormField
          label="Weight (%)"
          htmlFor="goal-weight"
          required
          hint="The share of the judgement. All goals must total 100 before the review can be sent for approval."
        >
          <Input
            id="goal-weight"
            type="number"
            min={1}
            max={100}
            step="0.01"
            required
            value={form.weight}
            onChange={(e) => set('weight', e.target.value)}
          />
        </FormField>

        <FormField label="Target" htmlFor="goal-target" hint="What good looks like, measurably.">
          <Input
            id="goal-target"
            value={form.target}
            onChange={(e) => set('target', e.target.value)}
            placeholder="Shipped to all customers by 30 June"
          />
        </FormField>

        <FormField label="Description" htmlFor="goal-description">
          <Textarea
            id="goal-description"
            rows={3}
            value={form.description}
            onChange={(e) => set('description', e.target.value)}
          />
        </FormField>

        <FormError message={error} />

        <FormActions loading={mutation.isPending} onClose={onClose} submitLabel="Add goal" />
      </form>
    </Modal>
  );
}
