import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Inbox } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/shared/api/client';
import { apiErrorMessage } from '@/shared/api/errors';
import {
  DecisionNote,
  Badge,
  ConfirmDialog,
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
import { useCurrentUser } from '@/shared/hooks/use-current-user';
import { usePermissions } from '@/shared/hooks/use-permissions';
import { formatDate, formatDateTime, orDash } from '@/shared/lib/format';
import { ReviewModal } from './review-modal';
import { RequestCommentsPanel } from './request-comments-panel';
import { canCancelRequest, isOpen } from './request-policy';
import { isSlaAtRisk, isSlaBreached } from './request-sla';
import { useRequests } from './use-requests';
import type { RequestItemResponse, RequestStatus } from '@/shared/api/types';

/*
 * WHAT THIS SCREEN NO LONGER CARRIES
 *
 * `STATUS_LABEL`, `STATUS_CLASS`, `PRIORITY_CLASS`, `PRIORITY_DOT` and `REQUEST_TYPE_LABEL` — five maps,
 * two of them colours. `PRIORITY_DOT` had a real defect in it: `bg-warning-bg0` and `bg-danger-bg0`,
 * with a trailing zero, so the dot rendered UNSTYLED for exactly the two priorities that matter. A
 * class-name typo cannot be caught by anything; a tone lookup cannot be mistyped without a type error.
 *
 * Also its own `formatDate`, a hand-rolled dialog, six raw header cells, a `dl` grid, a hand-built tab
 * strip, and a query casting the response to `{ data, total }` — `total` at the top level, where the
 * API returns it in `pageInfo`, so the footer read "Showing 12 of undefined requests".
 */

const STATUS_FILTERS: { value: RequestStatus | 'my_queue' | ''; label: string }[] = [
  { value: 'my_queue', label: 'My queue' },
  { value: '', label: 'All' },
  { value: 'pending', label: 'Pending' },
  { value: 'in_review', label: 'In review' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
];

/** Priority → tone. Its own vocabulary: nothing else in the product ranks urgency. */
const PRIORITY_TONE = {
  low: 'neutral',
  normal: 'blue',
  high: 'amber',
  urgent: 'red',
} as const;

export function RequestsPage() {
  const qc = useQueryClient();
  const me = useCurrentUser();
  const { can } = usePermissions();
  const [filter, setFilter] = useState<RequestStatus | 'my_queue' | ''>('my_queue');
  const [modal, setModal] = useState<{
    req: RequestItemResponse;
    action: 'approve' | 'reject';
  } | null>(null);
  const [cancelling, setCancelling] = useState<RequestItemResponse | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const list = useListState();

  const requests = useRequests(filter, list.limit, list.offset);
  const rows = requests.data?.data as RequestItemResponse[] | undefined;
  const invalidate = () => qc.invalidateQueries({ queryKey: ['requests'] });

  /**
   * The open request, READ BACK OUT OF THE LIST rather than held as a copy.
   *
   * Cancelling from the drawer moves the row's status, and a snapshot would leave the drawer showing
   * "Pending" over a request that had just been withdrawn — with its Cancel button still offered.
   */
  const selected = selectedId ? (rows?.find((req) => req.id === selectedId) ?? null) : null;

  // See `request-policy.ts` for why the rule lives there rather than in the JSX that reads it.
  const canCancel = (req: RequestItemResponse) =>
    canCancelRequest(req, me.data?.sub, can('rbac.manage'));

  async function cancel() {
    if (!cancelling) return;
    const { error } = await api.POST('/v1/requests/{id}/cancel', {
      params: { path: { id: cancelling.id } },
      /*
       * EMPTY BODY, deliberately. The route accepts `ReviewRequestDto` and so advertises an optional
       * `note`, but the controller calls `engine.cancel(id, user)` and drops it — nothing is stored and
       * nothing is audited from it. Collecting a reason here would be asking for text the product throws
       * away, which is worse than not asking.
       */
      body: {},
    });
    setCancelling(null);
    if (error) {
      toast.error(apiErrorMessage(error, 'Failed to cancel the request.'));
      return;
    }
    toast.success('Request cancelled');
    invalidate();
  }

  const columns: DataTableColumn<RequestItemResponse>[] = [
    {
      /*
       * WHAT THIS ROW USED TO SAY, and why it was not enough to decide from: the request type and
       * `id.slice(0, 8)`. No requester, no subject, nothing but a type an approver already knew from the
       * filter they clicked.
       *
       * The id made it worse rather than better. These are uuid v7 — TIME-PREFIXED — so requests filed
       * within the same window share their leading characters, and the only per-row identifier rendered
       * four visually identical values on a screen whose buttons are Approve and Reject.
       *
       * So the secondary line is the requester now, which is the fact an approver actually needs. The
       * full id lives in the drawer, where there is room for all of it.
       */
      key: 'request',
      header: 'Request',
      cell: (req) => (
        <div className="min-w-0">
          <p className="truncate font-medium text-fg">{humanizeStatus(req.type)}</p>
          <p className="truncate text-xs text-fg-subtle">
            {/* `orDash` rather than the raw id as a fallback: a missing name means the requester's row
                is gone, and showing a uuid there would reintroduce exactly what this replaced. */}
            {orDash(req.requesterName)}
          </p>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (req) => (
        <StatusBadge tone={statusTone(req.status)}>{humanizeStatus(req.status)}</StatusBadge>
      ),
    },
    {
      key: 'priority',
      header: 'Priority',
      cell: (req) => (
        <Badge tone={PRIORITY_TONE[req.priority as keyof typeof PRIORITY_TONE] ?? 'neutral'}>
          {humanizeStatus(req.priority)}
        </Badge>
      ),
      hideOnMobile: true,
    },
    {
      key: 'submitted',
      header: 'Submitted',
      cell: (req) => <span className="text-xs text-fg-muted">{formatDate(req.submittedAt)}</span>,
      hideOnMobile: true,
    },
    {
      /*
       * WHERE IT IS IN THE CHAIN. `currentStep` and `totalSteps` were already in the response and shown
       * nowhere, so a two-step approval looked identical to a one-step one — and an approver could not
       * tell whether saying yes finished the request or handed it on.
       *
       * Single-step requests say so rather than reading "1 of 1", which is noise on the majority of rows.
       */
      key: 'step',
      header: 'Step',
      cell: (req) =>
        req.totalSteps > 1 ? (
          <span className="text-xs text-fg-muted">
            {req.currentStep} of {req.totalSteps}
          </span>
        ) : (
          <span className="text-xs text-fg-subtle">Single</span>
        ),
      hideOnMobile: true,
    },
    {
      key: 'sla',
      header: 'SLA',
      cell: (req) => {
        if (isSlaBreached(req)) return <StatusBadge tone="red">Breached</StatusBadge>;
        if (isSlaAtRisk(req)) return <StatusBadge tone="amber">At risk</StatusBadge>;
        if (!req.slaDeadline) return <span className="text-xs text-fg-subtle">—</span>;
        return <span className="text-xs text-fg-subtle">Due {formatDate(req.slaDeadline)}</span>;
      },
    },
    {
      key: 'actions',
      header: 'Actions',
      align: 'right',
      // `RowActions`/`RowAction` from the kit, not two hand-rolled buttons with their own colour classes —
      // which is what these were, and the tones they wanted are variants `Button` already has.
      /*
       * OFFERED ONLY WHERE THE ENGINE WOULD ALLOW IT. This was gated on the status alone, so every
       * holder of `request.read` — `helpdesk` and `auditor` hold exactly that and no approval code —
       * saw Approve and Reject on every pending request in the tenant, and every click was a
       * permanent 403 shown as "please try again". So did every user on their OWN request, which
       * separation of duties refuses by design.
       *
       * `viewerMayDecide` comes from the engine that enforces it: the step's permission, the
       * separation-of-duties subject (the delegator, when acting under a delegation), and the union of
       * the two identities' permissions. None of that is derivable here.
       *
       * WHEN THE ANSWER IS NO, SAY WHY rather than showing nothing: "you raised this" and "you do not
       * hold the permission" lead to different next actions — ask a colleague, or ask for access.
       */
      cell: (req) => {
        if (!isOpen(req.status)) return null;
        if (req.viewerMayDecide) {
          return (
            <RowActions>
              <RowAction tone="success" onClick={() => setModal({ req, action: 'approve' })}>
                Approve
              </RowAction>
              <RowAction tone="danger" onClick={() => setModal({ req, action: 'reject' })}>
                Reject
              </RowAction>
            </RowActions>
          );
        }
        // Through the kit, which owns both sentences: the workforce leave, overtime and timesheet tabs
        // report the same fact about the same kind of request, and two copies of one rule drift.
        return <DecisionNote reason={req.viewerCannotDecideReason} />;
      },
    },
  ];

  return (
    <>
      {modal && (
        <ReviewModal
          request={modal.req}
          action={modal.action}
          onClose={() => setModal(null)}
          onSuccess={invalidate}
        />
      )}

      {/* The API's own precondition, said before the act: cancelling is terminal, and the alternative for
          somebody who is not the requester is to REJECT — which is a decision, not a withdrawal. */}
      <ConfirmDialog
        open={!!cancelling}
        variant="danger"
        onCancel={() => setCancelling(null)}
        onConfirm={cancel}
        title="Withdraw this request?"
        description="It stops awaiting a decision and cannot be reopened — a new request would have to be raised. The discussion and the approval history stay."
        confirmLabel="Withdraw request"
      />

      <ListPage
        title="Requests Inbox"
        description="Everything awaiting a decision, and everything already decided."
        filters={
          <SegmentedControl
            label="Filter requests"
            options={STATUS_FILTERS}
            value={filter}
            onChange={(value) => {
              setFilter(value);
              list.resetPaging();
            }}
          />
        }
        pageInfo={requests.data?.pageInfo}
        onOffsetChange={list.goToOffset}
        noun="requests"
      >
        <DataTable
          columns={columns}
          rows={rows}
          isLoading={requests.isLoading}
          isError={requests.isError}
          errorMessage="Failed to load requests."
          emptyMessage={
            filter === 'my_queue' ? 'Nothing awaiting your decision' : 'No requests found'
          }
          emptyIcon={Inbox}
          onRowClick={(req) => setSelectedId(req.id)}
          isRowActive={(req) => req.id === selectedId}
        />
      </ListPage>

      <EntityDetailPanel
        open={!!selected}
        onClose={() => setSelectedId(null)}
        width="lg"
        title={selected ? humanizeStatus(selected.type) : 'Request'}
        description={
          selected ? `${selected.id.slice(0, 8)} · ${humanizeStatus(selected.status)}` : undefined
        }
        headerActions={
          selected && canCancel(selected) ? (
            <PanelAction tone="danger" onClick={() => setCancelling(selected)}>
              Withdraw
            </PanelAction>
          ) : undefined
        }
        items={
          selected
            ? [
                { label: 'Type', value: humanizeStatus(selected.type) },
                {
                  label: 'Status',
                  value: (
                    <StatusBadge tone={statusTone(selected.status)}>
                      {humanizeStatus(selected.status)}
                    </StatusBadge>
                  ),
                },
                {
                  label: 'Priority',
                  value: (
                    <Badge
                      tone={
                        PRIORITY_TONE[selected.priority as keyof typeof PRIORITY_TONE] ?? 'neutral'
                      }
                    >
                      {humanizeStatus(selected.priority)}
                    </Badge>
                  ),
                },
                { label: 'Submitted', value: formatDateTime(selected.submittedAt) },
                {
                  label: 'Requester',
                  value: (
                    <span>
                      {orDash(selected.requesterName)}
                      {/* The uuid stays, in full and secondary: it is what somebody quotes in a ticket,
                          and the drawer has room where the row did not. */}
                      <span className="ml-2 font-mono text-2xs text-fg-subtle">
                        {selected.requesterId}
                      </span>
                    </span>
                  ),
                },
                {
                  label: 'Assignee',
                  /* The `assigneeId` guard stays: an UNASSIGNED request is a normal pending state, not a
                     missing name, and the row is better absent than showing a dash that reads like an
                     error. Once there IS an assignee, it is a person, so it is named like one. */
                  value: selected.assigneeId ? (
                    <span>
                      {orDash(selected.assigneeName)}
                      <span className="ml-2 font-mono text-2xs text-fg-subtle">
                        {selected.assigneeId}
                      </span>
                    </span>
                  ) : null,
                },
                { label: 'SLA deadline', value: formatDateTime(selected.slaDeadline) },
                {
                  label: 'Steps',
                  value:
                    selected.totalSteps > 1
                      ? `Step ${selected.currentStep} of ${selected.totalSteps}`
                      : null,
                },
                { label: 'Resolution note', value: selected.resolutionNote, wide: true },
              ]
            : []
        }
        activity={selected ? { resourceId: selected.id, resourceType: 'request' } : undefined}
      >
        {selected && (selected.approvals?.length ?? 0) > 0 && (
          <SlideOverSection title="Approval history">
            <ol className="flex flex-col gap-2">
              {selected.approvals!.map((a) => (
                <li key={a.id} className="flex items-start gap-3">
                  <StatusBadge tone={statusTone(a.decision)}>
                    Step {a.step} — {humanizeStatus(a.decision)}
                  </StatusBadge>
                  <div className="min-w-0 flex-1 text-xs text-fg-muted">
                    {/* Who decided this step — the point of an approval history. `orDash` and not the id
                        as the fallback, and the id kept beside it in full for a ticket, exactly as the
                        Requester row above. */}
                    <p>
                      {orDash(a.approverName)}
                      <span className="ml-2 font-mono text-2xs text-fg-subtle">{a.approverId}</span>
                    </p>
                    {a.note && <p className="mt-0.5">{a.note}</p>}
                    <p className="mt-0.5 text-fg-subtle">{formatDateTime(a.decidedAt)}</p>
                  </div>
                </li>
              ))}
            </ol>
          </SlideOverSection>
        )}

        {selected && (
          <SlideOverSection title="Discussion">
            <RequestCommentsPanel requestId={selected.id} />
          </SlideOverSection>
        )}
      </EntityDetailPanel>
    </>
  );
}
