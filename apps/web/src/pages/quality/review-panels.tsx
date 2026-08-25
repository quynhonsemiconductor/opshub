import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Snowflake } from 'lucide-react';
import { api } from '@/shared/api/client';
import { apiErrorMessage } from '@/shared/api/errors';
import { formatDate, formatDateTime, orDash, todayIso } from '@/shared/lib/format';
import { usePermissions } from '@/shared/hooks/use-permissions';
import { Badge, PanelAction, StatusBadge, humanizeStatus, statusTone } from '@/shared/ui';
import { ACTION_NEXT_ACTIONS, type ManagementReview, type ReviewAgenda } from './review.types';
import { ActionOutcomeModal, RaiseActionModal } from './review-action-modals';
import { useAgenda, useReviewActions } from './use-reviews';

/**
 * What a review's drawer has to answer: what it will consider, and what it decided.
 */

/** One agenda line: a count, and the references behind it so the number can be acted on. */
function AgendaLine({
  label,
  count,
  references = [],
  clause,
}: {
  label: string;
  count: number;
  references?: string[];
  /** The clause this input satisfies, so the agenda reads as the standard's list and not as a dashboard. */
  clause: string;
}) {
  return (
    <div className="flex flex-col gap-0.5 border-b border-border py-1.5 last:border-0">
      <div className="flex items-center gap-1.5">
        <span className="text-xs text-fg-muted">{label}</span>
        <span className="text-xs text-fg-subtle">{clause}</span>
        {/* Zero is the answer worth showing plainly: this input was considered and had nothing in it. */}
        <span
          className={`ml-auto tabular-nums text-xs ${count > 0 ? 'font-medium text-warning' : 'text-fg-subtle'}`}
        >
          {count}
        </span>
      </div>
      {references.length > 0 && (
        <p className="truncate font-mono text-xs text-fg-subtle">{references.join(', ')}</p>
      )}
    </div>
  );
}

/**
 * The §9.3.2 inputs.
 *
 * COMPOSED FROM THE OTHER REGISTERS, never stored — until the review is HELD, at which point the API freezes
 * them onto the row. So a scheduled review shows live numbers (which is what somebody preparing for the
 * meeting wants), and a held one shows the numbers as they were on the day (which is what the minutes have to
 * agree with). Both are read from the same endpoint; the difference is the API's, not this screen's.
 */
export function ReviewAgendaPanel({ review }: { review: ManagementReview }) {
  const agenda = useAgenda(review.id);
  const frozen = review.status !== 'scheduled';
  const data = (agenda.data ?? null) as ReviewAgenda | null;

  return (
    <div className="flex flex-col gap-2">
      {agenda.isLoading && <p className="text-xs text-fg-subtle">Assembling…</p>}
      {agenda.isError && <p className="text-xs text-danger">Failed to assemble the agenda.</p>}

      {data && (
        <>
          <p className="flex items-center gap-1.5 text-xs text-fg-subtle">
            {frozen && <Snowflake className="h-3.5 w-3.5 shrink-0" strokeWidth={2} />}
            {frozen
              ? `Frozen as at ${formatDateTime(data.assembledAt)} — the numbers the minutes were written against`
              : `Live as at ${formatDateTime(data.assembledAt)}. Holding the review freezes them.`}
          </p>

          <div className="rounded-md border border-border bg-surface px-2.5 py-1">
            <AgendaLine
              label="Actions carried forward"
              clause="§9.3.2(a)"
              count={data.previousActions.length}
              references={data.previousActions.slice(0, 6).map((action) => action.reviewReference)}
            />
            <AgendaLine
              label="Findings past containment"
              clause="§9.3.2(c)"
              count={data.nonconformities.containmentOverdue}
              references={data.nonconformities.overdueReferences.slice(0, 6)}
            />
            <AgendaLine
              label="Process areas with a recurrence"
              clause="§9.3.2(c)"
              count={data.nonconformities.recurringProcessAreas.length}
              references={data.nonconformities.recurringProcessAreas.slice(0, 6)}
            />
            <AgendaLine
              label="Findings tracing to no audit"
              clause="§9.3.2(c)"
              count={data.audits.findingsNotLinkedToAnAudit}
              references={data.audits.unlinkedReferences.slice(0, 6)}
            />
            <AgendaLine
              label="Suppliers overdue assessment"
              clause="§9.3.2(e)"
              count={data.externalProviders.reviewGaps}
              references={data.externalProviders.gapReferences.slice(0, 6)}
            />
            <AgendaLine
              label="Critical suppliers with no risk"
              clause="§9.3.2(e)"
              count={data.externalProviders.criticalWithoutRisk}
            />
            <AgendaLine
              label="Spend with unassessed suppliers"
              clause="§9.3.2(e)"
              count={data.externalProviders.unassessedSpendLines}
            />
            <AgendaLine
              label="Untreated risks"
              clause="§9.3.2(f)"
              count={data.risks.untreated}
              references={data.risks.untreatedReferences.slice(0, 6)}
            />
          </div>
        </>
      )}
    </div>
  );
}

/**
 * The review's outputs.
 *
 * A CLOSED REVIEW ACCEPTS NO NEW ONES: an action added after the minutes are issued is an output those
 * minutes do not contain. Raising one before the review is held is equally wrong — an output of a meeting
 * that has not happened — so the button appears only while the review is `held`.
 */
export function ReviewActionsPanel({ review }: { review: ManagementReview }) {
  const actions = useReviewActions({
    status: '',
    managementReviewId: review.id,
    openOnly: false,
    limit: 50,
    offset: 0,
  });
  const { can } = usePermissions();
  const queryClient = useQueryClient();
  const [raising, setRaising] = useState(false);
  const [outcomeFor, setOutcomeFor] = useState<{
    action: { id: string; description: string };
    outcome: 'complete' | 'cancel';
  } | null>(null);

  const rows = actions.data?.data ?? [];
  const canManage = can('management_review.manage');

  function refresh() {
    void queryClient.invalidateQueries({ queryKey: ['quality'] });
  }

  const start = useMutation({
    mutationFn: async (actionId: string) => {
      const { error } = await api.POST('/v1/management-reviews/actions/{actionId}/start', {
        params: { path: { actionId } },
      });
      if (error) throw new Error(apiErrorMessage(error, 'Failed to start the action.'));
    },
    onSuccess: () => {
      toast.success('Action in progress');
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="flex flex-col gap-2">
      {actions.isLoading && <p className="text-xs text-fg-subtle">Loading…</p>}
      {actions.isError && <p className="text-xs text-danger">Failed to load the actions.</p>}

      {/* A held review with no outputs is a finding of its own: §9.3.3 expects decisions and actions. */}
      {!actions.isLoading && !actions.isError && rows.length === 0 && (
        <p className={`text-xs ${review.status === 'held' ? 'text-warning' : 'text-fg-subtle'}`}>
          {review.status === 'held'
            ? 'No outputs yet — a review that decided nothing is hard to evidence against §9.3.3'
            : 'No outputs'}
        </p>
      )}

      {rows.map((action) => {
        const steps = ACTION_NEXT_ACTIONS[action.status] ?? [];
        const overdue = !!action.dueOn && action.dueOn < todayIso() && steps.length > 0;
        return (
          <div key={action.id} className="rounded-md border border-border bg-surface px-2.5 py-1.5">
            <div className="flex items-center gap-1.5">
              <Badge tone="neutral">{humanizeStatus(action.category)}</Badge>
              <StatusBadge tone={statusTone(action.status)}>
                {humanizeStatus(action.status)}
              </StatusBadge>
              {/* WHO is answerable, by name. §9.3.3 outputs exist to be followed up and this card
                  said the category, the status and the date but never the person — so it could report
                  an action three weeks overdue without saying overdue on whom. */}
              <span className="ml-auto truncate text-xs text-fg-subtle">
                {orDash(action.ownerName)}
              </span>
              {/* `shrink-0` because the owner name beside it truncates instead: a date that wraps
                  or clips is unreadable, and a long name is still recognisable cut short. */}
              <span className={`shrink-0 text-xs ${overdue ? 'text-warning' : 'text-fg-subtle'}`}>
                {action.dueOn ? `Due ${formatDate(action.dueOn)}` : 'No due date'}
              </span>
            </div>
            <p className="mt-0.5 whitespace-pre-wrap text-xs text-fg-muted">{action.description}</p>
            {action.outcomeNote && (
              <p className="mt-0.5 whitespace-pre-wrap text-xs text-fg-subtle">
                {action.outcomeNote}
              </p>
            )}

            {canManage && steps.length > 0 && (
              <div className="mt-1.5 flex flex-wrap items-center gap-1">
                {steps.includes('start') && (
                  <PanelAction onClick={() => start.mutate(action.id)} disabled={start.isPending}>
                    Start
                  </PanelAction>
                )}
                {steps.includes('complete') && (
                  <PanelAction
                    tone="success"
                    onClick={() =>
                      setOutcomeFor({
                        action: { id: action.id, description: action.description },
                        outcome: 'complete',
                      })
                    }
                  >
                    Complete
                  </PanelAction>
                )}
                {steps.includes('cancel') && (
                  <PanelAction
                    tone="danger"
                    onClick={() =>
                      setOutcomeFor({
                        action: { id: action.id, description: action.description },
                        outcome: 'cancel',
                      })
                    }
                  >
                    Cancel
                  </PanelAction>
                )}
              </div>
            )}
          </div>
        );
      })}

      {/* Only while `held`: before that there is no meeting to be an output of, and after closure the
          minutes are issued. */}
      {canManage && review.status === 'held' && (
        <div>
          <PanelAction tone="accent" onClick={() => setRaising(true)}>
            Raise an output
          </PanelAction>
        </div>
      )}

      {raising && (
        <RaiseActionModal review={review} onClose={() => setRaising(false)} onSuccess={refresh} />
      )}
      {outcomeFor && (
        <ActionOutcomeModal
          action={outcomeFor.action}
          outcome={outcomeFor.outcome}
          onClose={() => setOutcomeFor(null)}
          onSuccess={refresh}
        />
      )}
    </div>
  );
}
