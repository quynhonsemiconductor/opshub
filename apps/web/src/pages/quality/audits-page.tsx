import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ClipboardList, Link2Off, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/shared/api/client';
import { apiErrorMessage } from '@/shared/api/errors';
import {
  Badge,
  Button,
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
import { usePermissions } from '@/shared/hooks/use-permissions';
import { formatDate, orDash } from '@/shared/lib/format';
import {
  CancelAuditModal,
  PlanAuditModal,
  ReportAuditModal,
  StartAuditModal,
} from './audit-modals';
import { AuditFindingsPanel, AuditRosterPanel } from './audit-panels';
import { AUDIT_NEXT_ACTIONS, AUDIT_STATUS_FILTERS, type InternalAudit } from './audit.types';
import { useAudits, useUnlinkedFindings } from './use-audits';

/**
 * The internal-audit programme: what is planned, what is being examined, and what came out of it.
 *
 * CLOSING GOES THROUGH REPORTING, ALWAYS. `in_progress → closed` is refused by the service and by
 * `ck_audit_reported_pair`, which requires both a conclusion and a report document for `closed`. ISO 9001
 * §9.2.2(d) makes reporting results its own obligation: fieldwork that finished and results that reached
 * nobody is not a completed audit. So the register offers Report on fieldwork and Close only once reported.
 *
 * FIELDWORK NEEDS AUDITORS. The service refuses a start with an empty roster — a count over another table,
 * so no CHECK can hold it — and the row carries `auditorCount`, so this screen withholds Start rather than
 * letting somebody discover the rule through a toast.
 *
 * THE ROSTER IS THE IMPARTIALITY RECORD, not a team list: anybody on it is barred from certifying that a fix
 * for one of this audit's findings worked. That is enforced in `CapaService`, at the decision it constrains.
 */
export function AuditsPage() {
  const qc = useQueryClient();
  const list = useListState();
  const { can } = usePermissions();
  const canManage = can('internal_audit.manage');

  const [status, setStatus] = useState('');
  const [openOnly, setOpenOnly] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [acting, setActing] = useState<{
    audit: InternalAudit;
    action: 'start' | 'report' | 'cancel';
  } | null>(null);
  const [closing, setClosing] = useState<InternalAudit | null>(null);
  const [clicked, setClicked] = useState<InternalAudit | null>(null);

  const audits = useAudits({
    status,
    openOnly,
    search: list.search,
    limit: list.limit,
    offset: list.offset,
  });
  const unlinked = useUnlinkedFindings();
  const invalidate = () => qc.invalidateQueries({ queryKey: ['quality'] });

  // The drawer's subject, re-read from the page's own list so a roster change or a transition moves it. The
  // audit list already carries every field the drawer shows, so no second request is needed for it.
  const selected = clicked
    ? (audits.data?.data?.find((audit) => audit.id === clicked.id) ?? clicked)
    : null;

  function applyFilter(apply: () => void) {
    apply();
    list.resetPaging();
  }

  /** Whether fieldwork can begin: the transition is legal AND somebody is rostered to do it. */
  function startIsReachable(audit: InternalAudit): boolean {
    return (AUDIT_NEXT_ACTIONS[audit.status] ?? []).includes('start') && audit.auditorCount > 0;
  }

  async function runClose() {
    if (!closing) return;
    const { error } = await api.POST('/v1/internal-audits/{id}/close', {
      params: { path: { id: closing.id } },
    });
    setClosing(null);
    if (error) {
      toast.error(apiErrorMessage(error, 'Failed to close the audit.'));
      return;
    }
    toast.success('Audit closed');
    invalidate();
  }

  const columns: DataTableColumn<InternalAudit>[] = [
    {
      key: 'reference',
      header: 'Reference',
      cell: (audit) => (
        <span className="font-mono text-xs font-medium text-fg">{audit.reference}</span>
      ),
    },
    {
      key: 'title',
      header: 'Audit',
      cell: (audit) => (
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-fg">{audit.title}</p>
          <p className="truncate text-xs text-fg-subtle">{audit.scope}</p>
        </div>
      ),
    },
    {
      key: 'window',
      header: 'Planned',
      cell: (audit) => (
        <span className="text-xs text-fg-muted">
          {formatDate(audit.plannedStartOn)} – {formatDate(audit.plannedEndOn)}
        </span>
      ),
      hideOnMobile: true,
    },
    {
      key: 'roster',
      header: 'Roster',
      align: 'right',
      // Zero is the finding here, not a blank: an audit nobody is rostered to cannot start.
      cell: (audit) =>
        audit.auditorCount === 0 ? (
          <span className="text-xs text-warning">None</span>
        ) : (
          <span className="tabular-nums text-xs">{audit.auditorCount}</span>
        ),
    },
    {
      key: 'findings',
      header: 'Findings',
      align: 'right',
      // Open over total: ten findings all closed and ten all open are the same count and different audits.
      cell: (audit) => (
        <span className="tabular-nums text-xs">
          {audit.openFindingCount}/{audit.findingCount}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (audit) => (
        <StatusBadge tone={statusTone(audit.status)}>{humanizeStatus(audit.status)}</StatusBadge>
      ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: (audit) => {
        // From `AUDIT_NEXT_ACTIONS`, which mirrors the service's transition map.
        const steps = AUDIT_NEXT_ACTIONS[audit.status] ?? [];
        return (
          <RowActions>
            {/* Withheld while the roster is empty — the drawer's roster panel says why. */}
            {canManage && startIsReachable(audit) && (
              <RowAction tone="accent" onClick={() => setActing({ audit, action: 'start' })}>
                Start
              </RowAction>
            )}
            {canManage && steps.includes('report') && (
              <RowAction tone="accent" onClick={() => setActing({ audit, action: 'report' })}>
                Report
              </RowAction>
            )}
            {canManage && steps.includes('close') && (
              <RowAction tone="success" onClick={() => setClosing(audit)}>
                Close
              </RowAction>
            )}
            {canManage && steps.includes('cancel') && (
              <RowAction tone="danger" onClick={() => setActing({ audit, action: 'cancel' })}>
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
      <PlanAuditModal open={planning} onClose={() => setPlanning(false)} onSuccess={invalidate} />
      {acting?.action === 'start' && (
        <StartAuditModal
          audit={acting.audit}
          onClose={() => setActing(null)}
          onSuccess={invalidate}
        />
      )}
      {acting?.action === 'report' && (
        <ReportAuditModal
          audit={acting.audit}
          onClose={() => setActing(null)}
          onSuccess={invalidate}
        />
      )}
      {acting?.action === 'cancel' && (
        <CancelAuditModal
          audit={acting.audit}
          onClose={() => setActing(null)}
          onSuccess={invalidate}
        />
      )}

      {/* Closing takes no input: the conclusion and the report were recorded when results were reported, and
          this is the statement that the follow-up is finished. So a confirmation, not a form. */}
      <ConfirmDialog
        open={!!closing}
        onCancel={() => setClosing(null)}
        onConfirm={runClose}
        title="Close this audit?"
        description="The engagement is finished and its follow-up is complete. A closed audit accepts nothing further — its row and findings are the evidence it happened."
        confirmLabel="Close audit"
      />

      <ListPage
        title="Internal audits"
        description="The programme: what is planned, who is examining it, and what the engagement concluded."
        actions={
          canManage ? (
            <Button variant="primary" onClick={() => setPlanning(true)}>
              <Plus className="h-4 w-4" strokeWidth={2} />
              Plan an audit
            </Button>
          ) : undefined
        }
        search={{
          value: list.search,
          onChange: list.setSearch,
          placeholder: 'Search audits…',
        }}
        filters={
          <>
            <SegmentedControl
              label="Filter by status"
              options={AUDIT_STATUS_FILTERS.map((option) => ({ ...option }))}
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
        pageInfo={audits.data?.pageInfo}
        onOffsetChange={list.goToOffset}
        noun="audit"
      >
        {/* Findings from an audit source that trace to no engagement: either an audit nobody recorded, or a
            finding attributed to a process that never examined it. Rendered only when there are some. */}
        {(unlinked.data ?? []).length > 0 && (
          <div className="mb-4 rounded-lg border border-warning bg-warning-bg/40 px-3 py-2.5">
            <p className="flex items-center gap-1.5 text-xs font-medium text-warning">
              <Link2Off className="h-3.5 w-3.5" strokeWidth={2} />
              {unlinked.data!.length} audit-sourced finding(s) trace to no engagement
            </p>
            <ul className="mt-1 flex flex-col gap-0.5">
              {unlinked.data!.slice(0, 5).map((finding) => (
                <li key={finding.id} className="text-xs text-fg-muted">
                  <span className="font-mono">{finding.reference}</span> · {finding.title}
                  <Badge tone={statusTone(finding.severity)}>
                    {humanizeStatus(finding.severity)}
                  </Badge>
                  <span className="text-fg-subtle"> · {finding.processArea}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <DataTable
          columns={columns}
          rows={audits.data?.data}
          isLoading={audits.isLoading}
          isError={audits.isError}
          errorMessage="Failed to load the audit programme."
          emptyMessage="No audits match these filters"
          emptyIcon={ClipboardList}
          onRowClick={setClicked}
          isRowActive={(audit) => audit.id === selected?.id}
        />
      </ListPage>

      <EntityDetailPanel
        open={!!selected}
        onClose={() => setClicked(null)}
        title={selected?.title ?? 'Internal audit'}
        description={selected?.reference}
        headerActions={
          selected && canManage && startIsReachable(selected) ? (
            <PanelAction
              tone="accent"
              onClick={() => setActing({ audit: selected, action: 'start' })}
            >
              Start fieldwork
            </PanelAction>
          ) : selected &&
            canManage &&
            (AUDIT_NEXT_ACTIONS[selected.status] ?? []).includes('report') ? (
            <PanelAction
              tone="accent"
              onClick={() => setActing({ audit: selected, action: 'report' })}
            >
              Report results
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
                  label: 'Lead auditor',
                  // The NAME: §9.2.2 makes the lead accountable for the engagement, so a uuid here
                  // named nobody on the one line that has to name somebody.
                  value: (
                    <span>
                      {orDash(selected.leadAuditorName)}
                      {/* The uuid stays, secondary: it is what somebody quotes in a ticket. */}
                      <span className="ml-2 font-mono text-2xs text-fg-subtle">
                        {selected.leadAuditorId}
                      </span>
                    </span>
                  ),
                },
                { label: 'Objective', wide: true, value: selected.objective },
                { label: 'Scope', wide: true, value: selected.scope },
                { label: 'Criteria', wide: true, value: selected.criteria },
                {
                  label: 'Planned window',
                  value: `${formatDate(selected.plannedStartOn)} – ${formatDate(selected.plannedEndOn)}`,
                },
                { label: 'Fieldwork started', value: formatDate(selected.startedAt) },
                // Each of these appears only once it has happened: an empty "conclusion" on an audit still in
                // fieldwork reads as a gap in the record rather than a step not yet taken.
                ...(selected.reportedAt
                  ? [
                      { label: 'Reported', value: formatDate(selected.reportedAt) },
                      { label: 'Conclusion', wide: true, value: orDash(selected.conclusion) },
                      {
                        label: 'Report document',
                        value: (
                          <span className="font-mono text-xs">{selected.reportDocumentId}</span>
                        ),
                      },
                    ]
                  : []),
                ...(selected.closedAt
                  ? [{ label: 'Closed', value: formatDate(selected.closedAt) }]
                  : []),
                ...(selected.cancelReason
                  ? [{ label: 'Cancelled because', wide: true, value: selected.cancelReason }]
                  : []),
              ]
            : []
        }
        activity={
          selected ? { resourceId: selected.id, resourceType: 'internal_audit' } : undefined
        }
      >
        {selected && (
          <>
            <SlideOverSection title={`Roster (${selected.auditorCount})`}>
              <AuditRosterPanel audit={selected} />
            </SlideOverSection>
            <SlideOverSection
              title={`Findings (${selected.openFindingCount} open of ${selected.findingCount})`}
            >
              <AuditFindingsPanel auditId={selected.id} />
            </SlideOverSection>
          </>
        )}
      </EntityDetailPanel>
    </>
  );
}
