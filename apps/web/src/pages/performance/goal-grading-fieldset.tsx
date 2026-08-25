import { Badge, FormField, Select, Textarea } from '@/shared/ui';
import type { Goal, RatingLevel } from './performance.types';

/** A goal's grade and outcome as the reviewer is editing them, before they are saved. */
export interface GoalGrade {
  rating: string;
  outcome: string;
}

/**
 * Grading the goals, inside the rating form.
 *
 * WHY THIS EXISTS AT ALL. `POST /performance/reviews/:id/rating` has always accepted
 * `goals: [{ id, rating, outcome }]`, and the rating form never sent the field. Nothing else can set
 * a goal's grade — `SetGoalSchema` has no rating — so every goal stayed ungraded for ever, and
 * `assertGoalsComplete` refuses to submit a review that has an ungraded goal on it. A review with a
 * single goal could therefore never leave the reviewer's desk, while the confirmation dialog on
 * "Send for approval" named the rule and offered no way to satisfy it. The panel that renders
 * `goal.rating` was a dead branch.
 *
 * SEPARATE FILE because the rating form crossed the 486-line ceiling the FE consistency ratchet
 * holds, and that ratchet's instruction is the right one: a sixty-line fieldset is a component.
 */
export function GoalGradingFieldset({
  goals,
  scale,
  values,
  onChange,
}: {
  goals: Goal[];
  scale: RatingLevel[];
  /** Current edits, keyed by goal id. Absent means "whatever is saved on the goal". */
  values: Record<string, GoalGrade>;
  onChange: (goalId: string, next: GoalGrade) => void;
}) {
  if (goals.length === 0) return null;

  const rows = goals.map((goal) => ({
    goal,
    value: values[goal.id] ?? { rating: goal.rating ?? '', outcome: goal.outcome ?? '' },
  }));
  const ungraded = rows.filter((row) => !row.value.rating).length;
  const weightTotal = rows.reduce((sum, row) => sum + Number(row.goal.weight), 0);

  return (
    <fieldset className="flex flex-col gap-3 rounded-lg border border-border p-3">
      <legend className="px-1 text-xs font-medium text-fg-muted">
        Goals ({rows.length}) — {weightTotal}% of the judgement
      </legend>
      {/*
        The two rules that block submission, stated before the reviewer hits them rather than after.
        Both are the API's, and both are refusals a reviewer cannot otherwise predict.
      */}
      {ungraded > 0 && (
        <p className="text-xs text-fg-muted">
          {ungraded} still ungraded. A review cannot be sent for approval until every goal has a
          grade.
        </p>
      )}
      {weightTotal !== 100 && (
        <p className="text-xs text-fg-muted">
          The weights carry {weightTotal}%, not 100%. Adjust them so the overall rating can be
          traced to the goals.
        </p>
      )}
      {rows.map(({ goal, value }) => (
        <div
          key={goal.id}
          className="flex flex-col gap-2 border-t border-border pt-3 first:border-0 first:pt-0"
        >
          <div className="flex items-start justify-between gap-2">
            <p className="text-sm font-medium text-fg">{goal.title}</p>
            <Badge>{Number(goal.weight)}%</Badge>
          </div>
          {goal.target && <p className="text-xs text-fg-subtle">Target: {goal.target}</p>}
          <FormField label="Grade" htmlFor={`goal-rating-${goal.id}`}>
            <Select
              id={`goal-rating-${goal.id}`}
              value={value.rating}
              onChange={(e) => onChange(goal.id, { ...value, rating: e.target.value })}
            >
              <option value="">Not graded yet</option>
              {scale.map((option) => (
                <option key={option.code} value={option.code}>
                  {option.label}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField
            label="Outcome"
            htmlFor={`goal-outcome-${goal.id}`}
            hint="What actually happened against this goal."
          >
            <Textarea
              id={`goal-outcome-${goal.id}`}
              rows={2}
              value={value.outcome}
              onChange={(e) => onChange(goal.id, { ...value, outcome: e.target.value })}
              placeholder="Shipped in May, two weeks after the date we agreed…"
            />
          </FormField>
        </div>
      ))}
    </fieldset>
  );
}
