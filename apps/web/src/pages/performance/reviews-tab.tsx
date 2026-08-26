import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ClipboardCheck } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/shared/api/client';
import { apiErrorMessage } from '@/shared/api/errors';
import { activeEmployeeOptions } from '@/shared/api/picker-sources';
import { useAuthStore } from '@/shared/api/auth-store';
import {
  Badge,
  ConfirmDialog,
  DataTable,
  EntityDetailPanel,
  EntityPicker,
  PaginationFooter,
  PanelAction,
  RowAction,
  RowActions,
  SegmentedControl,
  SlideOverSection,
  StatusBadge,
  TabToolbar,
  humanizeStatus,
  statusTone,
  type DataTableColumn,
} from '@/shared/ui';
import { useListState } from '@/shared/hooks/use-list-state';
import { usePermissions } from '@/shared/hooks/use-permissions';
import { formatDate, formatDateTime, orDash } from '@/shared/lib/format';
import { GoalsPanel } from './goals-panel';
import { CancelReviewModal, RateReviewModal, SelfAssessmentModal } from './rating-modals';
import { ReassignReviewerModal } from './review-modals';
import { REVIEW_STATUS_FILTERS } from './performance.types';
import { useCycleLabels, useOpenCycles, useReviews } from './use-performance';
import type { Review } from './performance.types';

/**
 * Every review, and the actions each state allows.
 *
 * ACTIONS ARE GATED ON WHO YOU ARE, not only on the status. Only the ASSIGNED REVIEWER writes the
 * review — naming the reviewer on the row is what makes rating a scope rule rather than a permission, so
 * a manager needs no code to write the review they were given and `performance.manage` does not let
 * anybody write somebody else's. The UI mirrors that with `user.sub`, and the API refuses regardless:
 * hiding a button is a courtesy, not the control.
 *
 * SUBMIT GOES TO AN APPROVAL CHAIN, which is why "Send for approval" is not "Share". The engine keeps the
 * submitter out of their own chain, and the type def additionally refuses the SUBJECT as approver —
 * otherwise anybody holding `performance.approve` could sign off their own review.
 *
 * SO THE ROW ACTIONS AND THE DRAWER ACTIONS ARE GOVERNED DIFFERENTLY, route by route, and the difference
 * is not cosmetic:
 *   · Self-assess and Acknowledge are the SUBJECT'S — the controller rejects anybody else by id and says
 *     `performance.manage` "does not help here", because a self-assessment somebody else wrote is not one
 *     and an acknowledgement recorded by a third party is evidence of nothing. Gating these on a
 *     permission would have hidden the two things an ordinary employee comes to this page to do, which is
 *     the same defect as the ungated buttons, pointing the other way.
 *   · Rate and Send for approval are the ASSIGNED REVIEWER'S, enforced in the service. Also no permission.
 *   · Reassign (`PATCH reviews/{id}/reviewer`) and Cancel (`POST reviews/{id}/cancel`) DO carry
 *     `@RequirePermission(PERMISSION.PERFORMANCE_MANAGE)`. They were the two ungated ones: every holder of
 *     `performance.read` was offered the power to move somebody else's review to a different reviewer, or
 *     withdraw it, from the drawer header.
 *   · Goals are the widest — `mustWriteReview` accepts the assigned reviewer OR `performance.manage`,
 *     because HR sets a cycle's goals up and the reviewer refines them. See the `GoalsPanel` call.
 */
export function ReviewsTab() {
  const qc = useQueryClient();
  const list = useListState();
  const me = useAuthStore((state) => state.user);
  const { can } = usePermissions();
  const canManage = can('performance.manage');
  const [status, setStatus] = useState('');
  const [cycleId, setCycleId] = useState('');
  const [employeeId, setEmployeeId] = useState('');
  const [reviewerId, setReviewerId] = useState('');
  const [selected, setSelected] = useState<Review | null>(null);
  const [rating, setRating] = useState<Review | null>(null);
  const [reassigning, setReassigning] = useState<Review | null>(null);
  const [cancelling, setCancelling] = useState<Review | null>(null);
  const [selfAssessing, setSelfAssessing] = useState<Review | null>(null);
  const [submitting, setSubmitting] = useState<Review | null>(null);

  const reviews = useReviews({
    cycleId,
    employeeId,
    reviewerId,
    status,
    limit: list.limit,
    offset: list.offset,
  });
  // Labels for the cycles ON THIS PAGE, and separately the open cycles to filter by — see
  // `useCycleLabels`, which exists because a hundred-row lookup left most rows showing a raw id.
  const cycleNames = useCycleLabels((reviews.data?.data ?? []).map((review) => review.cycleId));
  const openCycles = useOpenCycles();

  const invalidate = () => qc.invalidateQueries({ queryKey: ['performance'] });
  const cycleLabel = (id: string) => cycleNames.get(id)?.reference ?? id;
  const isReviewer = (review: Review) => !!me && review.reviewerId === me.sub;
  const isSubject = (review: Review) => !!me && review.employeeId === me.sub;

  async function sendForApproval() {
    if (!submitting) return;
    const { error } = await api.POST('/v1/performance/reviews/{id}/submit', {
      params: { path: { id: submitting.id } },
    });
    setSubmitting(null);
    if (error) {
      // The refusals here are the ones the UI cannot pre-empt: weights that do not total 100, a goal
      // left unrated, a rating that demands a development plan it does not have.
      toast.error(apiErrorMessage(error, 'Failed to send the review for approval.'));
      return;
    }
    toast.success('Sent for approval');
    invalidate();
  }

  async function acknowledge(review: Review) {
    const { error } = await api.POST('/v1/performance/reviews/{id}/acknowledge', {
      params: { path: { id: review.id } },
    });
    if (error) {
      toast.error(apiErrorMessage(error, 'Failed to acknowledge the review.'));
      return;
    }
    toast.success('Review acknowledged');
    invalidate();
  }

  function applyFilter(apply: () => void) {
    apply();
    list.resetPaging();
  }

  const columns: DataTableColumn<Review>[] = [
    {
      key: 'cycle',
      header: 'Cycle',
      cell: (review) => (
        <span className="font-mono text-xs font-medium text-fg">{cycleLabel(review.cycleId)}</span>
      ),
    },
    {
      key: 'employee',
      header: 'Employee',
      // The name. "Who reviews whom" is the sentence at the top of this page, and two columns of
      // uuid could not answer it.
      cell: (review) => (
        <span className="text-xs text-fg-muted">{orDash(review.employeeName)}</span>
      ),
    },
    {
      key: 'reviewer',
      header: 'Reviewer',
      // "You" rather than an id when it is the caller's: this list is how a manager finds their own
      // queue, and matching a UUID against your own by eye is not a thing anybody does.
      cell: (review) =>
        isReviewer(review) ? (
          <Badge tone="blue">You</Badge>
        ) : (
          <span className="text-xs text-fg-muted">{orDash(review.reviewerName)}</span>
        ),
      hideOnMobile: true,
    },
    {
      key: 'rating',
      header: 'Rating',
      cell: (review) =>
        review.overallRating ? (
          <Badge>{humanizeStatus(review.overallRating)}</Badge>
        ) : (
          <span className="text-xs text-fg-subtle">Not rated</span>
        ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (review) => (
        <StatusBadge tone={statusTone(review.status)}>{humanizeStatus(review.status)}</StatusBadge>
      ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: (review) => (
        <RowActions>
          {review.status === 'self_assessment' && isSubject(review) && (
            <RowAction tone="accent" onClick={() => setSelfAssessing(review)}>
              Self-assess
            </RowAction>
          )}
          {review.status === 'manager_review' && isReviewer(review) && (
            <>
              <RowAction tone="accent" onClick={() => setRating(review)}>
                Rate
              </RowAction>
              {/* Offered only once a rating exists: submitting an unrated review is a refusal, and an
                  action whose only outcome is an error is worse than no action. */}
              {review.overallRating && (
                <RowAction tone="success" onClick={() => setSubmitting(review)}>
                  Send for approval
                </RowAction>
              )}
            </>
          )}
          {review.status === 'shared' && isSubject(review) && (
            <RowAction tone="success" onClick={() => void acknowledge(review)}>
              Acknowledge
            </RowAction>
          )}
        </RowActions>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      {rating && (
        <RateReviewModal review={rating} onClose={() => setRating(null)} onSuccess={invalidate} />
      )}
      {reassigning && (
        <ReassignReviewerModal
          review={reassigning}
          onClose={() => setReassigning(null)}
          onSuccess={invalidate}
        />
      )}
      {cancelling && (
        <CancelReviewModal
          review={cancelling}
          onClose={() => setCancelling(null)}
          onSuccess={invalidate}
        />
      )}
      {selfAssessing && (
        <SelfAssessmentModal
          review={selfAssessing}
          onClose={() => setSelfAssessing(null)}
          onSuccess={invalidate}
        />
      )}

      <ConfirmDialog
        open={!!submitting}
        onCancel={() => setSubmitting(null)}
        onConfirm={sendForApproval}
        title="Send this review for approval?"
        description="It goes to an approver before the employee sees it. Refused unless the goal weights total 100, every goal is rated, and any rating that demands a development plan has one."
        confirmLabel="Send for approval"
      />

      <TabToolbar
        filter={
          <div className="flex flex-wrap items-center gap-2">
            <SegmentedControl
              label="Filter by status"
              options={REVIEW_STATUS_FILTERS.map((option) => ({ ...option }))}
              value={status}
              onChange={(value) => applyFilter(() => setStatus(value))}
            />
            <div className="w-52">
              <EntityPicker
                ariaLabel="Filter by employee"
                queryKey="active-employees"
                value={employeeId}
                onChange={(value) => applyFilter(() => setEmployeeId(value))}
                fetchOptions={activeEmployeeOptions}
                placeholder="Any employee"
              />
            </div>
            <div className="w-52">
              <EntityPicker
                ariaLabel="Filter by reviewer"
                queryKey="active-employees"
                value={reviewerId}
                onChange={(value) => applyFilter(() => setReviewerId(value))}
                fetchOptions={activeEmployeeOptions}
                placeholder="Any reviewer"
              />
            </div>
            {/* The OPEN cycles, which is what somebody filters by — a closed one is history and is
                reached through the cycle list instead. Two at most, because the control is a segmented
                switch and a year's worth of references would not fit in one. */}
            <div className="w-44">
              <SegmentedControl
                label="Filter by cycle"
                options={[
                  { value: '', label: 'All cycles' },
                  ...(openCycles.data ?? [])
                    .slice(0, 2)
                    .map((cycle) => ({ value: cycle.id, label: cycle.reference })),
                ]}
                value={cycleId}
                onChange={(value) => applyFilter(() => setCycleId(value))}
              />
            </div>
          </div>
        }
      />

      <DataTable
        columns={columns}
        rows={reviews.data?.data}
        isLoading={reviews.isLoading}
        isError={reviews.isError}
        errorMessage="Failed to load reviews."
        emptyMessage="No reviews match these filters"
        emptyIcon={ClipboardCheck}
        onRowClick={setSelected}
        isRowActive={(review) => review.id === selected?.id}
      />

      <PaginationFooter
        pageInfo={reviews.data?.pageInfo}
        onOffsetChange={list.goToOffset}
        noun="review"
      />

      <EntityDetailPanel
        open={!!selected}
        onClose={() => setSelected(null)}
        title={selected ? cycleLabel(selected.cycleId) : 'Review'}
        description={selected ? humanizeStatus(selected.status) : undefined}
        headerActions={
          // BOTH OF THESE ARE `performance.manage`, and the status conjunction stays because it answers a
          // different question — a cancelled or acknowledged review is finished, so there is nothing left
          // to reassign or withdraw whoever is asking. Withheld silently rather than explained: unlike
          // the certificates panel next door, there is nothing a manager could do about it and nothing
          // they were looking for here, so a sentence in the drawer header would only be noise.
          selected &&
          canManage &&
          selected.status !== 'cancelled' &&
          selected.status !== 'acknowledged' ? (
            <>
              <PanelAction tone="muted" onClick={() => setReassigning(selected)}>
                Reassign
              </PanelAction>
              <PanelAction tone="danger" onClick={() => setCancelling(selected)}>
                Cancel
              </PanelAction>
            </>
          ) : undefined
        }
        items={
          selected
            ? [
                {
                  label: 'Status',
                  value: (
                    <StatusBadge tone={statusTone(selected.status)}>
                      {humanizeStatus(selected.status)}
                    </StatusBadge>
                  ),
                },
                {
                  label: 'Employee',
                  value: (
                    <span>
                      {orDash(selected.employeeName)}
                      <span className="ml-2 font-mono text-2xs text-fg-subtle">
                        {selected.employeeId}
                      </span>
                    </span>
                  ),
                },
                {
                  label: 'Reviewer',
                  value: (
                    <span>
                      {orDash(selected.reviewerName)}
                      <span className="ml-2 font-mono text-2xs text-fg-subtle">
                        {selected.reviewerId}
                      </span>
                    </span>
                  ),
                },
                {
                  label: 'Rating',
                  value: selected.overallRating
                    ? humanizeStatus(selected.overallRating)
                    : 'Not rated',
                },
                { label: 'Rated', value: formatDateTime(selected.ratedAt) },
                { label: 'Acknowledged', value: formatDateTime(selected.acknowledgedAt) },
                {
                  label: 'Self-assessment',
                  wide: true,
                  value: selected.selfAssessment ? (
                    <p className="whitespace-pre-wrap text-sm text-fg-muted">
                      {selected.selfAssessment}
                    </p>
                  ) : (
                    // Distinguishes "not written" from an empty string, because a cycle can have no
                    // self-assessment step at all.
                    <span className="text-xs text-fg-subtle">
                      {selected.selfAssessmentSubmittedAt ? orDash(null) : 'Not submitted'}
                    </span>
                  ),
                },
                ...(selected.managerSummary
                  ? [
                      {
                        label: 'Summary',
                        wide: true,
                        value: (
                          <p className="whitespace-pre-wrap text-sm text-fg-muted">
                            {selected.managerSummary}
                          </p>
                        ),
                      },
                    ]
                  : []),
                ...(selected.developmentPlan
                  ? [
                      {
                        label: 'Development plan',
                        wide: true,
                        value: (
                          <p className="whitespace-pre-wrap text-sm text-fg-muted">
                            {selected.developmentPlan}
                          </p>
                        ),
                      },
                    ]
                  : []),
                ...(selected.approvedAt
                  ? [{ label: 'Approved', value: formatDate(selected.approvedAt) }]
                  : []),
              ]
            : []
        }
        activity={
          selected ? { resourceId: selected.id, resourceType: 'performance_review' } : undefined
        }
      >
        {selected && (
          <SlideOverSection title="Goals">
            <GoalsPanel
              reviewId={selected.id}
              // REVIEWER **OR** `performance.manage`, which is wider than this used to be and matches
              // `mustWriteReview`: the controller's own docblock says HR sets a cycle's goals up and the
              // reviewer refines them, "so both routes exist for both people". Gating on `isReviewer`
              // alone locked HR out of the setup step their own routes were written for — the mirror
              // image of the ungated buttons, and just as invisible, because the admin seats the browser
              // suite runs as are reviewers on the seeded data and never noticed.
              //
              // The status half is unchanged and still ANDed: once a review is with an approver the goal
              // set is what was judged, and that is true of HR and the reviewer alike.
              canEdit={(isReviewer(selected) || canManage) && selected.status === 'manager_review'}
            />
          </SlideOverSection>
        )}
      </EntityDetailPanel>
    </div>
  );
}
