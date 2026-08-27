import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Plus, Target, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/shared/api/client';
import { apiErrorMessage } from '@/shared/api/errors';
import { Badge, Button, ConfirmDialog, PanelState, RowActions, Tooltip } from '@/shared/ui';
import { orDash } from '@/shared/lib/format';
import { SetGoalModal } from './rating-modals';
import { REQUIRED_WEIGHT_TOTAL } from './performance.types';
import { useReviewGoals } from './use-performance';
import type { Goal } from './performance.types';

/**
 * The goals a review is judged against, and the one number that decides whether it can be submitted.
 *
 * THE RUNNING TOTAL IS THE POINT. Weights must sum to 100 before the review goes for approval — a sum
 * across rows, so no database CHECK sees it and the API enforces it at submit time. Without this line
 * the rule is discovered at the moment somebody tries to submit, with a set adding to 90 and no
 * indication of which goal is wrong. Shown as `90 / 100` with the shortfall named.
 *
 * Deliberately NOT a client-side block on submit: the API owns the rule (with a cent of tolerance,
 * because the column is `numeric(5,2)`), and a second copy here would be a second thing to keep in
 * agreement with it. This tells the truth about where the set stands; the API decides.
 */
export function GoalsPanel({
  reviewId,
  canEdit,
}: {
  reviewId: string;
  /** Goals are the reviewer's to set, and only while the review is still being written. */
  canEdit: boolean;
}) {
  const qc = useQueryClient();
  const goals = useReviewGoals(reviewId);
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<Goal | null>(null);

  const invalidate = () => qc.invalidateQueries({ queryKey: ['performance'] });

  const rows = goals.data ?? [];
  const total = rows.reduce((sum, goal) => sum + Number(goal.weight), 0);
  const complete = Math.abs(total - REQUIRED_WEIGHT_TOTAL) < 0.011;

  async function remove() {
    if (!deleting) return;
    const { error } = await api.DELETE('/v1/performance/reviews/{id}/goals/{goalId}', {
      params: { path: { id: reviewId, goalId: deleting.id } },
    });
    setDeleting(null);
    if (error) {
      toast.error(apiErrorMessage(error, 'Failed to remove the goal.'));
      return;
    }
    toast.success('Goal removed');
    invalidate();
  }

  return (
    <div className="flex flex-col gap-2">
      {adding && (
        <SetGoalModal
          reviewId={reviewId}
          remainingWeight={Math.max(0, Math.round((REQUIRED_WEIGHT_TOTAL - total) * 100) / 100)}
          onClose={() => setAdding(false)}
          onSuccess={invalidate}
        />
      )}

      <ConfirmDialog
        open={!!deleting}
        onCancel={() => setDeleting(null)}
        onConfirm={remove}
        title="Remove this goal?"
        description="The weights will no longer total 100, so the review cannot be sent for approval until they do again."
        confirmLabel="Remove goal"
        variant="danger"
      />

      <PanelState
        query={goals}
        count={rows.length}
        empty="No goals set"
        error="Failed to load the goals."
      />

      {rows.map((goal) => (
        <div
          key={goal.id}
          className="flex items-start gap-2 rounded-md border border-border bg-surface px-2.5 py-2"
        >
          <Target className="mt-0.5 h-4 w-4 shrink-0 text-fg-subtle" strokeWidth={1.75} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-medium text-fg">{goal.title}</p>
            <p className="truncate text-xs text-fg-subtle">Target: {orDash(goal.target)}</p>
            {goal.outcome && <p className="truncate text-xs text-fg-muted">{goal.outcome}</p>}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <Badge>{Number(goal.weight)}%</Badge>
            {goal.rating && <Badge tone="blue">{goal.rating}</Badge>}
            {canEdit && (
              <RowActions>
                {/*
                 * THE CONSEQUENCE, BEFORE THE CLICK. This icon said `title="Remove"` — the same word as
                 * its `aria-label`, so a slow duplicate of the name and nothing else. What a reader
                 * cannot see is that removing a goal takes its weight out of the running total below and
                 * therefore blocks the whole review from being submitted; the confirmation says so, but
                 * only after the trash can has been pressed.
                 */}
                <Tooltip
                  content={`Frees this goal's ${Number(goal.weight)}% — the review cannot go for approval until the weights total ${REQUIRED_WEIGHT_TOTAL} again.`}
                >
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Remove ${goal.title}`}
                    onClick={() => setDeleting(goal)}
                  >
                    <Trash2 className="h-3.5 w-3.5" strokeWidth={2} />
                  </Button>
                </Tooltip>
              </RowActions>
            )}
          </div>
        </div>
      ))}

      {rows.length > 0 && (
        <p className={`text-xs ${complete ? 'text-success' : 'text-warning'}`}>
          Weights total {Math.round(total * 100) / 100} / {REQUIRED_WEIGHT_TOTAL}
          {!complete &&
            ` — ${Math.round((REQUIRED_WEIGHT_TOTAL - total) * 100) / 100} to allocate before this can be sent for approval`}
        </p>
      )}

      {canEdit && (
        <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
          <Plus className="h-3.5 w-3.5" strokeWidth={2} />
          Add goal
        </Button>
      )}
    </div>
  );
}
