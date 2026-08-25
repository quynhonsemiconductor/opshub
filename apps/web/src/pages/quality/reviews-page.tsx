import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CalendarCheck, Plus, Repeat2 } from 'lucide-react';
import {
  Badge,
  Button,
  DataTable,
  EntityDetailPanel,
  ListPage,
  PanelAction,
  RowAction,
  RowActions,
  SegmentedControl,
  SlideOverSection,
  StatusBadge,
  humanizeStatus,
  statusTone,
  type DataTableColumn,
} from '@/shared/ui';
import { useListState } from '@/shared/hooks/use-list-state';
import { usePermissions } from '@/shared/hooks/use-permissions';
import { formatDate, orDash } from '@/shared/lib/format';
import {
  CancelReviewModal,
  CloseReviewModal,
  HoldReviewModal,
  ScheduleReviewModal,
} from './review-modals';
import { ReviewActionsPanel, ReviewAgendaPanel } from './review-panels';
import { REVIEW_NEXT_ACTIONS, REVIEW_STATUS_FILTERS, type ManagementReview } from './review.types';
import { useCarriedForward, useReviews } from './use-reviews';

/**
 * Management reviews — ISO 9001 §9.3.
 *
 * HELD AND CLOSED ARE DIFFERENT THINGS. §9.3.3 requires documented outputs, so a meeting that happened and
 * whose minutes were never issued is not a completed review — which is why closing needs both a conclusion
 * and a minutes document, and why `cancelled` is unreachable once a review has been held.
 *
 * HOLDING FREEZES THE AGENDA. The §9.3.2 inputs are composed from the other registers, and the API writes
 * them onto the row when the review is held: minutes have to show what the numbers WERE on the day. Nothing
 * on this screen sends them.
 *
 * REVIEWS ARE HELD IN ORDER. §9.3.2(a) asks for the status of actions from PREVIOUS reviews, which only means
 * something if "previous" is settled — so the API refuses to hold one while an earlier scheduled review is
 * still outstanding. That is a statement about another row, so this screen leaves it to the API's refusal
 * rather than guessing at ordering it cannot see across pages.
 */
export function ReviewsPage() {
  const qc = useQueryClient();
  const list = useListState();
  const { can } = usePermissions();
  const canManage = can('management_review.manage');

  const [status, setStatus] = useState('');
  const [openOnly, setOpenOnly] = useState(false);
  const [scheduling, setScheduling] = useState(false);
  const [acting, setActing] = useState<{
    review: ManagementReview;
    action: 'hold' | 'close' | 'cancel';
  } | null>(null);
  const [clicked, setClicked] = useState<ManagementReview | null>(null);

  const reviews = useReviews({
    status,
    openOnly,
    search: list.search,
    limit: list.limit,
    offset: list.offset,
  });
  const carried = useCarriedForward();
  const invalidate = () => qc.invalidateQueries({ queryKey: ['quality'] });

  // Re-read from the list, so holding a review or completing an action moves the drawer with it.
  const selected = clicked
    ? (reviews.data?.data?.find((review) => review.id === clicked.id) ?? clicked)
    : null;

  function applyFilter(apply: () => void) {
    apply();
    list.resetPaging();
  }

  const columns: DataTableColumn<ManagementReview>[] = [
    {
      key: 'reference',
      header: 'Reference',
      cell: (review) => (
        <span className="font-mono text-xs font-medium text-fg">{review.reference}</span>
      ),
    },
    {
      key: 'title',
      header: 'Review',
      cell: (review) => (
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-fg">{review.title}</p>
          <p className="truncate text-xs text-fg-subtle">{review.period}</p>
        </div>
      ),
    },
    {
      key: 'when',
      header: 'Scheduled',
      cell: (review) => (
        <span className="text-xs text-fg-muted">
          {review.heldOn ? `Held ${formatDate(review.heldOn)}` : formatDate(review.scheduledFor)}
        </span>
      ),
    },
    {
      key: 'actions-count',
      header: 'Outputs',
      align: 'right',
      // Open over total: the open ones are what the NEXT review has to carry forward.
      cell: (review) => (
        <span className="tabular-nums text-xs">
          {review.openActionCount}/{review.actionCount}
        </span>
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
      cell: (review) => {
        const steps = REVIEW_NEXT_ACTIONS[review.status] ?? [];
        return (
          <RowActions>
            {canManage && steps.includes('hold') && (
              <RowAction tone="accent" onClick={() => setActing({ review, action: 'hold' })}>
                Hold
              </RowAction>
            )}
            {canManage && steps.includes('close') && (
              <RowAction tone="success" onClick={() => setActing({ review, action: 'close' })}>
                Close
              </RowAction>
            )}
            {canManage && steps.includes('cancel') && (
              <RowAction tone="danger" onClick={() => setActing({ review, action: 'cancel' })}>
                Cancel
              </RowAction>
            )}
          </RowActions>
        );
      },
    },
  ];

  return (
    <>
      <ScheduleReviewModal
        open={scheduling}
        onClose={() => setScheduling(false)}
        onSuccess={invalidate}
      />
      {acting?.action === 'hold' && (
        <HoldReviewModal
          review={acting.review}
          onClose={() => setActing(null)}
          onSuccess={invalidate}
        />
      )}
      {acting?.action === 'close' && (
        <CloseReviewModal
          review={acting.review}
          onClose={() => setActing(null)}
          onSuccess={invalidate}
        />
      )}
      {acting?.action === 'cancel' && (
        <CancelReviewModal
          review={acting.review}
          onClose={() => setActing(null)}
          onSuccess={invalidate}
        />
      )}

      <ListPage
        title="Management reviews"
        description="The §9.3 programme: what each review considered, what it decided, and whether those decisions were carried out."
        actions={
          canManage ? (
            <Button variant="primary" onClick={() => setScheduling(true)}>
              <Plus className="h-4 w-4" strokeWidth={2} />
              Schedule a review
            </Button>
          ) : undefined
        }
        search={{
          value: list.search,
          onChange: list.setSearch,
          placeholder: 'Search reviews…',
        }}
        filters={
          <>
            <SegmentedControl
              label="Filter by status"
              options={REVIEW_STATUS_FILTERS.map((option) => ({ ...option }))}
              value={status}
              onChange={(value) => applyFilter(() => setStatus(value))}
            />
            <Button
              variant={openOnly ? 'primary' : 'outline'}
              size="sm"
              aria-pressed={openOnly}
              onClick={() => applyFilter(() => setOpenOnly(!openOnly))}
            >
              Outstanding only
            </Button>
          </>
        }
        pageInfo={reviews.data?.pageInfo}
        onOffsetChange={list.goToOffset}
        noun="review"
      >
        {/* §9.3.2(a) as a banner: actions from earlier reviews that are still open. An action carried
            forward twice is the signal the clause exists to produce, so `daysOverdue` is the API's. */}
        {(carried.data ?? []).length > 0 && (
          <div className="mb-4 rounded-lg border border-warning bg-warning-bg/40 px-3 py-2.5">
            <p className="flex items-center gap-1.5 text-xs font-medium text-warning">
              <Repeat2 className="h-3.5 w-3.5" strokeWidth={2} />
              {carried.data!.length} action(s) from earlier reviews are still open
            </p>
            <ul className="mt-1 flex flex-col gap-0.5">
              {carried.data!.slice(0, 5).map((action) => (
                <li key={action.id} className="text-xs text-fg-muted">
                  <span className="font-mono">{action.reviewReference}</span>
                  <Badge tone="neutral">{humanizeStatus(action.category)}</Badge>{' '}
                  {action.description}
                  {action.daysOverdue != null && action.daysOverdue > 0 && (
                    <span className="text-warning"> — {action.daysOverdue} day(s) overdue</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        <DataTable
          columns={columns}
          rows={reviews.data?.data}
          isLoading={reviews.isLoading}
          isError={reviews.isError}
          errorMessage="Failed to load the review programme."
          emptyMessage="No reviews match these filters"
          emptyIcon={CalendarCheck}
          onRowClick={setClicked}
          isRowActive={(review) => review.id === selected?.id}
        />
      </ListPage>

      <EntityDetailPanel
        open={!!selected}
        onClose={() => setClicked(null)}
        title={selected?.title ?? 'Management review'}
        description={selected ? `${selected.reference} · ${selected.period}` : undefined}
        headerActions={
          selected && canManage && (REVIEW_NEXT_ACTIONS[selected.status] ?? []).includes('hold') ? (
            <PanelAction
              tone="accent"
              onClick={() => setActing({ review: selected, action: 'hold' })}
            >
              Record as held
            </PanelAction>
          ) : selected &&
            canManage &&
            (REVIEW_NEXT_ACTIONS[selected.status] ?? []).includes('close') ? (
            <PanelAction
              tone="success"
              onClick={() => setActing({ review: selected, action: 'close' })}
            >
              Close review
            </PanelAction>
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
                { label: 'Period', value: selected.period },
                {
                  label: 'Chair',
                  // The NAME: §9.3 makes the chair the accountable party for the review, and the
                  // minutes cite them by name, so a uuid here agreed with nothing anybody reads.
                  value: (
                    <span>
                      {orDash(selected.chairName)}
                      {/* The uuid stays, secondary: it is what somebody quotes in a ticket. */}
                      <span className="ml-2 font-mono text-2xs text-fg-subtle">
                        {selected.chairId}
                      </span>
                    </span>
                  ),
                },
                { label: 'Scheduled for', value: formatDate(selected.scheduledFor) },
                ...(selected.heldOn ? [{ label: 'Held', value: formatDate(selected.heldOn) }] : []),
                ...(selected.closedAt
                  ? [
                      { label: 'Closed', value: formatDate(selected.closedAt) },
                      { label: 'Conclusion', wide: true, value: orDash(selected.conclusion) },
                      {
                        label: 'Minutes document',
                        value: (
                          <span className="font-mono text-xs">{selected.minutesDocumentId}</span>
                        ),
                      },
                    ]
                  : []),
                ...(selected.cancelReason
                  ? [{ label: 'Cancelled because', wide: true, value: selected.cancelReason }]
                  : []),
              ]
            : []
        }
        activity={
          selected ? { resourceId: selected.id, resourceType: 'management_review' } : undefined
        }
      >
        {selected && (
          <>
            <SlideOverSection title="Inputs (§9.3.2)">
              <ReviewAgendaPanel review={selected} />
            </SlideOverSection>
            <SlideOverSection
              title={`Outputs (${selected.openActionCount} open of ${selected.actionCount})`}
            >
              <ReviewActionsPanel review={selected} />
            </SlideOverSection>
          </>
        )}
      </EntityDetailPanel>
    </>
  );
}
