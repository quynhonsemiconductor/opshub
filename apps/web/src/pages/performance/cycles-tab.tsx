import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CalendarRange, Plus, UserPlus } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/shared/api/client';
import { apiErrorMessage } from '@/shared/api/errors';
import {
  Badge,
  Button,
  ConfirmDialog,
  DataTable,
  EntityDetailPanel,
  PaginationFooter,
  PanelAction,
  RowActions,
  SegmentedControl,
  SlideOverSection,
  StatusBadge,
  TabToolbar,
  Tooltip,
  humanizeStatus,
  statusTone,
  type DataTableColumn,
  PanelState,
} from '@/shared/ui';
import { useListState } from '@/shared/hooks/use-list-state';
import { usePermissions } from '@/shared/hooks/use-permissions';
import { formatDate } from '@/shared/lib/format';
import { CreateCycleModal } from './cycle-modals';
import { CreateReviewModal } from './review-modals';
import { CYCLE_STATUS_FILTERS } from './performance.types';
import { useCycleCoverage, useCycleProgress, useCycles } from './use-performance';
import type { Cycle } from './performance.types';

/**
 * Review cycles: the period, its deadlines, and whether it actually covered everybody.
 *
 * A CYCLE DOES NOT CLOSE OVER REVIEWS IN FLIGHT — a count across rows, enforced by the service, and the
 * reason the close confirmation says so rather than just asking twice. Closing regardless would make the
 * coverage report claim a cycle finished that nobody finished.
 *
 * THE COVERAGE REPORT IS THE POINT OF THE DRAWER. "Did everybody get reviewed" cannot be answered from
 * the review list, because the people missing from it are the answer — so the API computes who has no
 * review, or one that never reached `shared`, and this shows it next to the progress counts.
 *
 * THE COVERAGE REPORT IS ALSO WHY A READ-ONLY TIER BELONGS HERE. `GET cycles`, `GET cycles/{id}/progress`
 * and `GET cycles/{id}/coverage` all ask for `performance.read`; the four write controls — `POST cycles`,
 * `POST cycles/{id}/open`, `POST cycles/{id}/close` and `POST cycles/{id}/reviews` — every one of them
 * carries `@RequirePermission(PERMISSION.PERFORMANCE_MANAGE)`. `ROLE.MANAGER` holds the read code and
 * not the manage code, which is the whole persona this screen serves: a People Manager comes here to see
 * whether their team got reviewed, and was previously shown New cycle, Open, Close and Add a review —
 * six dead buttons on the one page written for them.
 */
export function CyclesTab() {
  const qc = useQueryClient();
  const list = useListState();
  const { can } = usePermissions();
  const canManage = can('performance.manage');
  const [status, setStatus] = useState('all');
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<Cycle | null>(null);
  const [addingReviewTo, setAddingReviewTo] = useState<Cycle | null>(null);
  const [transition, setTransition] = useState<{ cycle: Cycle; to: 'open' | 'close' } | null>(null);

  const cycles = useCycles(status, list.limit, list.offset);
  const progress = useCycleProgress(selected?.id ?? null);
  const [coverageOffset, setCoverageOffset] = useState(0);
  const coverage = useCycleCoverage(selected?.id ?? null, coverageOffset);

  /**
   * Opening a cycle starts its coverage report at the beginning.
   *
   * The offset belongs to the REPORT, not to the panel: page to 50 in a cycle with hundreds
   * outstanding, close it, open one with three, and the request asks for rows 51–75 of three. The API
   * answers correctly — an empty page — and the panel would show "Everybody in scope has a completed
   * review" in green over a cycle nobody has reviewed.
   */
  function openCycle(cycle: Cycle): void {
    setCoverageOffset(0);
    setSelected(cycle);
  }
  const invalidate = () => qc.invalidateQueries({ queryKey: ['performance'] });

  async function runTransition() {
    if (!transition) return;
    const { cycle, to } = transition;
    const path =
      to === 'open' ? '/v1/performance/cycles/{id}/open' : '/v1/performance/cycles/{id}/close';
    const { error } = await api.POST(path, { params: { path: { id: cycle.id } } });
    setTransition(null);
    if (error) {
      toast.error(apiErrorMessage(error, `Failed to ${to} the cycle.`));
      return;
    }
    toast.success(to === 'open' ? 'Cycle opened' : 'Cycle closed');
    invalidate();
  }

  const columns: DataTableColumn<Cycle>[] = [
    {
      key: 'reference',
      header: 'Reference',
      cell: (cycle) => (
        <span className="font-mono text-xs font-medium text-fg">{cycle.reference}</span>
      ),
    },
    {
      key: 'name',
      header: 'Cycle',
      cell: (cycle) => (
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-fg">{cycle.name}</p>
          <p className="truncate text-xs text-fg-subtle">
            {formatDate(cycle.periodStart)} – {formatDate(cycle.periodEnd)}
          </p>
        </div>
      ),
    },
    {
      key: 'selfDue',
      header: 'Self-assessment due',
      // No self-assessment step is a property of the cycle, not a missing date.
      cell: (cycle) =>
        cycle.selfAssessmentDue ? (
          formatDate(cycle.selfAssessmentDue)
        ) : (
          <span className="text-xs text-fg-subtle">Not required</span>
        ),
      hideOnMobile: true,
    },
    { key: 'reviewDue', header: 'Review due', cell: (cycle) => formatDate(cycle.reviewDue) },
    {
      key: 'status',
      header: 'Status',
      cell: (cycle) => (
        <StatusBadge tone={statusTone(cycle.status)}>{humanizeStatus(cycle.status)}</StatusBadge>
      ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      // PERMISSION OUTSIDE, STATE INSIDE. The status conditions below decide which transition a cycle
      // has available; `canManage` decides whether this reader may make any transition at all. They are
      // not the same question and one boolean cannot answer both — a draft cycle a manager may not open
      // and an open cycle they may not close are two different sentences with the same answer here.
      cell: (cycle) =>
        canManage ? (
          <RowActions>
            {/*
              OPEN ONLY. This read `status !== 'closed'` under a comment claiming reviews are added while
              a cycle is "a DRAFT or OPEN" — and `createReview` refuses anything but open, with a message
              naming the state. So the action was offered on every draft cycle, the reviewer filled in two
              employee pickers, and the save was refused by a rule no screen had mentioned. The comment
              was the wrong side of the disagreement: the API's refusal is pinned by a test.
            */}
            {cycle.status === 'open' && (
              <Tooltip content="Add a review">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Add a review to ${cycle.reference}`}
                  onClick={() => setAddingReviewTo(cycle)}
                >
                  <UserPlus className="h-3.5 w-3.5" strokeWidth={2} />
                </Button>
              </Tooltip>
            )}
            {cycle.status === 'draft' && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setTransition({ cycle, to: 'open' })}
              >
                Open
              </Button>
            )}
            {cycle.status === 'open' && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setTransition({ cycle, to: 'close' })}
              >
                Close
              </Button>
            )}
          </RowActions>
        ) : null,
    },
  ];

  const totalReviews = (progress.data ?? []).reduce((sum, row) => sum + row.count, 0);

  return (
    <div className="flex flex-col gap-4">
      <CreateCycleModal open={creating} onClose={() => setCreating(false)} onSuccess={invalidate} />
      {addingReviewTo && (
        <CreateReviewModal
          cycle={addingReviewTo}
          onClose={() => setAddingReviewTo(null)}
          onSuccess={invalidate}
        />
      )}

      <ConfirmDialog
        open={!!transition}
        onCancel={() => setTransition(null)}
        onConfirm={runTransition}
        title={transition?.to === 'open' ? 'Open this cycle?' : 'Close this cycle?'}
        description={
          transition?.to === 'open'
            ? 'Employees and reviewers can start writing. Reviews can still be added afterwards.'
            : 'Refused while any review is still in flight — a cycle that closed over unfinished reviews would make the coverage report claim it was completed.'
        }
        confirmLabel={transition?.to === 'open' ? 'Open cycle' : 'Close cycle'}
      />

      <TabToolbar
        filter={
          <SegmentedControl
            label="Filter by status"
            options={CYCLE_STATUS_FILTERS.map((option) => ({ ...option }))}
            value={status}
            onChange={(value) => {
              setStatus(value);
              list.resetPaging();
            }}
          />
        }
        action={
          canManage ? (
            <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
              <Plus className="h-3.5 w-3.5" strokeWidth={2} />
              New cycle
            </Button>
          ) : undefined
        }
      />

      <DataTable
        columns={columns}
        rows={cycles.data?.data}
        isLoading={cycles.isLoading}
        isError={cycles.isError}
        errorMessage="Failed to load review cycles."
        emptyMessage="No review cycles yet"
        emptyIcon={CalendarRange}
        emptyAction={
          !canManage ? undefined : (
            <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
              <Plus className="h-3.5 w-3.5" /> Create your first cycle
            </Button>
          )
        }
        onRowClick={openCycle}
        isRowActive={(cycle) => cycle.id === selected?.id}
      />

      <PaginationFooter
        pageInfo={cycles.data?.pageInfo}
        onOffsetChange={list.goToOffset}
        noun="cycle"
      />

      <EntityDetailPanel
        open={!!selected}
        onClose={() => setSelected(null)}
        title={selected?.name ?? 'Cycle'}
        description={selected?.reference}
        headerActions={
          // `=== 'open'`, matching the row action rather than the `!== 'closed'` this used to read. The
          // row was corrected to the API's actual rule and the drawer was left behind, so the refusal
          // the comment above describes survived at the second entry point to the same route — which is
          // exactly how the ungated buttons this commit removes came to exist. The permission joins it
          // for the same reason: a gate on one of two paths to a route is not a gate.
          selected && canManage && selected.status === 'open' ? (
            <PanelAction tone="accent" onClick={() => setAddingReviewTo(selected)}>
              Add a review
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
                {
                  label: 'Period',
                  value: `${formatDate(selected.periodStart)} – ${formatDate(selected.periodEnd)}`,
                },
                {
                  label: 'Self-assessment due',
                  value: selected.selfAssessmentDue
                    ? formatDate(selected.selfAssessmentDue)
                    : 'Not required',
                },
                { label: 'Review due', value: formatDate(selected.reviewDue) },
                { label: 'Opened', value: formatDate(selected.openedAt) },
                { label: 'Closed', value: formatDate(selected.closedAt) },
              ]
            : []
        }
        activity={
          selected ? { resourceId: selected.id, resourceType: 'performance_cycle' } : undefined
        }
      >
        {selected && (
          <>
            <SlideOverSection title={`Progress (${totalReviews})`}>
              {/* `PanelState`, because this had no error branch and its empty test read
                  `!isLoading && totalReviews === 0` — true on failure as well, since `data` is
                  undefined and the count is therefore zero. A failed load claimed "No reviews in this
                  cycle yet": not a blank panel, a false statement. */}
              <PanelState
                query={progress}
                count={totalReviews}
                empty="No reviews in this cycle yet"
                error="Failed to load this cycle's progress."
              />
              <div className="flex flex-wrap gap-1.5">
                {(progress.data ?? []).map((row) => (
                  <Badge key={row.status} tone={statusTone(row.status)}>
                    {humanizeStatus(row.status)} · {row.count}
                  </Badge>
                ))}
              </div>
            </SlideOverSection>

            {/* THE HEADING COUNTS EVERYBODY OUTSTANDING, not the rows on screen. It used to count the
                array the endpoint returned, which the endpoint capped at 500 — so past five hundred
                active employees the report got shorter as the organisation got bigger, and the number
                beside "Not covered" was the size of a page dressed up as a total. */}
            <SlideOverSection title={`Not covered (${coverage.data?.pageInfo?.total ?? 0})`}>
              {/* An empty coverage report is the GOOD outcome, so it says so rather than showing an
                  empty list that reads as a failed fetch — hence `emptyTone="success"`.
                  Through `PanelState` because this was the worst instance of the missing-error bug:
                  no error branch, and an empty test true on failure, so a broken request announced a
                  compliance all-clear in green. */}
              <PanelState
                query={coverage}
                count={coverage.data?.pageInfo?.total ?? 0}
                empty="Everybody in scope has a completed review"
                emptyTone="success"
                error="Failed to load the coverage report."
              />
              <div className="flex flex-col gap-1.5">
                {(coverage.data?.data ?? []).map((gap) => (
                  <div
                    key={gap.employeeId}
                    className="flex items-center justify-between gap-2 rounded-md border border-border bg-surface px-2.5 py-1.5"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-xs font-medium text-fg">{gap.employeeName}</p>
                      <p className="truncate text-xs text-fg-subtle">{gap.email}</p>
                    </div>
                    {/* `status: null` means NO review at all, which is a different problem from one that
                        stalled — so it is named rather than shown as a dash. */}
                    <Badge tone={gap.status ? 'amber' : 'red'}>
                      {gap.status ? humanizeStatus(gap.status) : 'No review'}
                    </Badge>
                  </div>
                ))}
              </div>
              {/* The kit's pager, reading the API's own `pageInfo` — it renders nothing when everything
                  fits on one page, so the common case is unchanged. */}
              <PaginationFooter
                pageInfo={coverage.data?.pageInfo}
                onOffsetChange={setCoverageOffset}
                noun="outstanding"
              />
            </SlideOverSection>
          </>
        )}
      </EntityDetailPanel>
    </div>
  );
}
