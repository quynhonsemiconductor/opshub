import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertOctagon, Plus, Siren } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/shared/api/client';
import { apiErrorMessage } from '@/shared/api/errors';
import { activeEmployeeOptions } from '@/shared/api/picker-sources';
import {
  Badge,
  Button,
  ConfirmDialog,
  DataTable,
  EntityDetailPanel,
  EntityPicker,
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
import { formatDateTime } from '@/shared/lib/format';
import { DismissIncidentModal } from './incident-record-modals';
import {
  CloseIncidentModal,
  ContainIncidentModal,
  ResolveIncidentModal,
  TriageIncidentModal,
} from './incident-transition-modals';
import { ReportIncidentModal } from './report-incident-modal';
import { TimelinePanel } from './timeline-panel';
import {
  BREACH_NOTIFICATION_HOURS,
  INCIDENT_STATUS_FILTERS,
  NEXT_ACTIONS,
  isTerminalIncidentStatus,
} from './incident.types';
import { useIncidents, useOverdueBreaches } from './use-incidents';
import { incidentDetailItems } from './incident-detail-items';
import type { Incident } from './incident.types';

/**
 * Security incidents: report, triage, contain, resolve, close — and the breach clock.
 *
 * REPORTING IS UNGATED, DELIBERATELY. `POST /incidents/report` needs no permission because anybody who
 * notices something must be able to raise it; `incident.manage` governs the handling. So the primary
 * action is on the page for every reader, and only the row actions check the code.
 *
 * THE 72-HOUR CLOCK IS THE API'S. `notificationDueAt` is computed from `detectedAt` for a personal-data
 * breach, and `/breaches/overdue` reports what has passed it WITH the hours overdue. Nothing here does
 * that arithmetic: a deadline calculated in two places is a deadline two systems can disagree about, and
 * this one has a regulator on the other end.
 *
 * WHICH ACTION A ROW OFFERS comes from `NEXT_ACTIONS`, mirroring the API's own transition map. The screen
 * uses it to decide which BUTTON to draw and never to decide whether a move is legal — the service and a
 * guarded `WHERE status = <from>` do that, so two responders working one incident race in Postgres.
 */
export function IncidentsPage() {
  const qc = useQueryClient();
  const list = useListState();
  const { can } = usePermissions();
  const canManage = can('incident.manage');

  const [status, setStatus] = useState('');
  const [severity, setSeverity] = useState('');
  const [breachesOnly, setBreachesOnly] = useState(false);
  const [assignedTo, setAssignedTo] = useState('');
  const [reporting, setReporting] = useState(false);
  const [selected, setSelected] = useState<Incident | null>(null);
  const [triaging, setTriaging] = useState<Incident | null>(null);
  const [containing, setContaining] = useState<Incident | null>(null);
  const [resolving, setResolving] = useState<Incident | null>(null);
  const [closing, setClosing] = useState<Incident | null>(null);
  const [dismissing, setDismissing] = useState<Incident | null>(null);
  const [notifying, setNotifying] = useState<Incident | null>(null);
  /** The incident being CORRECTED, as opposed to a new one being reported. Same form, `PATCH` not `POST`. */
  const [correcting, setCorrecting] = useState<Incident | null>(null);

  const incidents = useIncidents({
    status,
    severity,
    openOnly: false,
    breachesOnly,
    assignedTo,
    limit: list.limit,
    offset: list.offset,
  });
  const overdue = useOverdueBreaches();
  const invalidate = () => qc.invalidateQueries({ queryKey: ['incidents'] });

  async function recordRegulatorNotified() {
    if (!notifying) return;
    const { error } = await api.POST('/v1/incidents/{id}/regulator-notified', {
      params: { path: { id: notifying.id } },
      // No timestamp: the API stamps now. Backdating a regulator notification is not something to offer
      // behind a confirm dialog.
      body: {},
    });
    setNotifying(null);
    if (error) {
      toast.error(apiErrorMessage(error, 'Failed to record the notification.'));
      return;
    }
    toast.success('Regulator notification recorded');
    invalidate();
  }

  function applyFilter(apply: () => void) {
    apply();
    list.resetPaging();
  }

  const columns: DataTableColumn<Incident>[] = [
    {
      key: 'reference',
      header: 'Reference',
      cell: (incident) => (
        <span className="font-mono text-xs font-medium text-fg">{incident.reference}</span>
      ),
    },
    {
      key: 'title',
      header: 'Incident',
      cell: (incident) => (
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-fg">{incident.title}</p>
          <p className="truncate text-xs text-fg-subtle">{incident.category}</p>
        </div>
      ),
    },
    {
      key: 'severity',
      header: 'Severity',
      cell: (incident) => (
        <Badge tone={statusTone(incident.severity)}>{humanizeStatus(incident.severity)}</Badge>
      ),
    },
    {
      key: 'breach',
      header: 'Breach',
      // Three states, and they are different questions: not a breach, a breach still inside its window,
      // and a breach already notified. A blank would collapse the first two.
      cell: (incident) =>
        !incident.personalDataBreach ? (
          <span className="text-xs text-fg-subtle">No</span>
        ) : incident.regulatorNotifiedAt ? (
          <Badge tone="green">Notified</Badge>
        ) : (
          <Badge tone="red">Due {formatDateTime(incident.notificationDueAt)}</Badge>
        ),
    },
    {
      key: 'assignee',
      header: 'Owner',
      cell: (incident) =>
        incident.assignedTo ? (
          <span className="font-mono text-xs text-fg-muted">{incident.assignedTo}</span>
        ) : (
          <span className="text-xs text-fg-subtle">Unassigned</span>
        ),
      hideOnMobile: true,
    },
    {
      key: 'detected',
      header: 'Detected',
      cell: (incident) => formatDateTime(incident.detectedAt),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (incident) => (
        <StatusBadge tone={statusTone(incident.status)}>
          {humanizeStatus(incident.status)}
        </StatusBadge>
      ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: (incident) => {
        if (!canManage) return null;
        const next = NEXT_ACTIONS[incident.status] ?? [];
        return (
          <RowActions>
            {/*
              CORRECT, on anything still being handled. `PATCH /v1/incidents/:id` has existed since the
              module was written and no screen called it, so a severity graded in the first ten minutes
              of a response — the field the queue is ORDERED by — stayed wrong for ever, as did a
              wrongly-ticked personal-data breach and a missing link to the risk it realised.

              Not on `closed` or `false_positive`: `updateIncident` calls `assertOpen` and answers
              `INCIDENT_NOT_IN_STATE` with "add a timeline entry instead", so drawing the action there
              would offer a button whose only outcome is a refusal. `isTerminalIncidentStatus` is the
              same list the API filters its open queue with, so the two cannot disagree.
            */}
            {!isTerminalIncidentStatus(incident.status) && (
              <RowAction tone="muted" onClick={() => setCorrecting(incident)}>
                Correct
              </RowAction>
            )}
            {next.includes('triage') && (
              <RowAction tone="accent" onClick={() => setTriaging(incident)}>
                Triage
              </RowAction>
            )}
            {next.includes('contain') && (
              <RowAction tone="accent" onClick={() => setContaining(incident)}>
                Contain
              </RowAction>
            )}
            {next.includes('resolve') && (
              <RowAction tone="success" onClick={() => setResolving(incident)}>
                Resolve
              </RowAction>
            )}
            {next.includes('close') && (
              <RowAction tone="success" onClick={() => setClosing(incident)}>
                Close
              </RowAction>
            )}
            {next.includes('dismiss') && (
              <RowAction tone="danger" onClick={() => setDismissing(incident)}>
                Dismiss
              </RowAction>
            )}
          </RowActions>
        );
      },
    },
  ];

  return (
    <>
      <ReportIncidentModal
        open={reporting}
        onClose={() => setReporting(false)}
        onSuccess={invalidate}
      />
      {/* One form, two verbs: `incident` present means correct the record rather than report a new one. */}
      {correcting && (
        <ReportIncidentModal
          open
          incident={correcting}
          onClose={() => setCorrecting(null)}
          onSuccess={invalidate}
        />
      )}
      {triaging && (
        <TriageIncidentModal
          incident={triaging}
          onClose={() => setTriaging(null)}
          onSuccess={invalidate}
        />
      )}
      {containing && (
        <ContainIncidentModal
          incident={containing}
          onClose={() => setContaining(null)}
          onSuccess={invalidate}
        />
      )}
      {resolving && (
        <ResolveIncidentModal
          incident={resolving}
          onClose={() => setResolving(null)}
          onSuccess={invalidate}
        />
      )}
      {closing && (
        <CloseIncidentModal
          incident={closing}
          onClose={() => setClosing(null)}
          onSuccess={invalidate}
        />
      )}
      {dismissing && (
        <DismissIncidentModal
          incident={dismissing}
          onClose={() => setDismissing(null)}
          onSuccess={invalidate}
        />
      )}

      <ConfirmDialog
        open={!!notifying}
        onCancel={() => setNotifying(null)}
        onConfirm={recordRegulatorNotified}
        title="Record the regulator notification?"
        description={`Stamped with the current time. This is the record that the ${BREACH_NOTIFICATION_HOURS}-hour obligation was met, so it is not something to record before the notification has actually gone.`}
        confirmLabel="Record notification"
      />

      <ListPage
        title="Incidents"
        description="What went wrong, who is handling it, what was learned — and which breaches are running out of time."
        actions={
          // UNGATED: reporting needs no permission by design.
          <Button variant="primary" onClick={() => setReporting(true)}>
            <Plus className="h-4 w-4" strokeWidth={2} />
            Report an incident
          </Button>
        }
        filters={
          <>
            <SegmentedControl
              label="Filter by status"
              options={INCIDENT_STATUS_FILTERS.map((option) => ({ ...option }))}
              value={status}
              onChange={(value) => applyFilter(() => setStatus(value))}
            />
            <SegmentedControl
              label="Filter by severity"
              options={[
                { value: '', label: 'Any' },
                { value: 'critical', label: 'Critical' },
                { value: 'high', label: 'High' },
              ]}
              value={severity}
              onChange={(value) => applyFilter(() => setSeverity(value))}
            />
            <Button
              variant={breachesOnly ? 'primary' : 'outline'}
              size="sm"
              aria-pressed={breachesOnly}
              onClick={() => applyFilter(() => setBreachesOnly(!breachesOnly))}
            >
              Personal-data breaches
            </Button>
            <div className="w-52">
              <EntityPicker
                ariaLabel="Filter by owner"
                queryKey="active-employees"
                value={assignedTo}
                onChange={(value) => applyFilter(() => setAssignedTo(value))}
                fetchOptions={activeEmployeeOptions}
                placeholder="Any owner"
              />
            </div>
          </>
        }
        pageInfo={incidents.data?.pageInfo}
        onOffsetChange={list.goToOffset}
        noun="incident"
      >
        {/* Only when something IS overdue. A permanently visible empty banner is a banner people learn to
            skip, and this is the one that must never be skipped. */}
        {(overdue.data?.length ?? 0) > 0 && (
          <div className="mb-4 rounded-lg border border-danger bg-danger-bg/40 px-3 py-2.5">
            <p className="flex items-center gap-1.5 text-xs font-medium text-danger">
              <Siren className="h-3.5 w-3.5" strokeWidth={2} />
              {overdue.data?.length} breach(es) past the {BREACH_NOTIFICATION_HOURS}-hour
              notification deadline
            </p>
            <ul className="mt-1 flex flex-col gap-0.5">
              {(overdue.data ?? []).slice(0, 5).map((breach) => (
                <li key={breach.id} className="text-xs text-fg-muted">
                  <span className="font-mono">{breach.reference}</span> · {breach.title}
                  {/* Hours overdue comes from the API. Rounded for reading, not recomputed. */}
                  <span className="text-danger"> — {Math.round(breach.hoursOverdue)}h overdue</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <DataTable
          columns={columns}
          rows={incidents.data?.data}
          isLoading={incidents.isLoading}
          isError={incidents.isError}
          errorMessage="Failed to load incidents."
          emptyMessage="No incidents match these filters"
          emptyIcon={AlertOctagon}
          emptyAction={
            <Button variant="primary" size="sm" onClick={() => setReporting(true)}>
              <Plus className="h-3.5 w-3.5" /> Report your first incident
            </Button>
          }
          onRowClick={setSelected}
          isRowActive={(incident) => incident.id === selected?.id}
        />
      </ListPage>

      <EntityDetailPanel
        open={!!selected}
        onClose={() => setSelected(null)}
        title={selected?.title ?? 'Incident'}
        description={selected?.reference}
        headerActions={
          selected && canManage && selected.personalDataBreach && !selected.regulatorNotifiedAt ? (
            <PanelAction tone="danger" onClick={() => setNotifying(selected)}>
              Regulator notified
            </PanelAction>
          ) : undefined
        }
        items={selected ? incidentDetailItems(selected) : []}
        activity={selected ? { resourceId: selected.id, resourceType: 'incident' } : undefined}
      >
        {selected && (
          <SlideOverSection title="Timeline">
            <TimelinePanel
              incident={selected}
              // A closed incident's timeline is the record. Appending to it after the fact would be
              // editing history that an audit has already read.
              canManage={canManage && selected.status !== 'closed'}
            />
          </SlideOverSection>
        )}
      </EntityDetailPanel>
    </>
  );
}
