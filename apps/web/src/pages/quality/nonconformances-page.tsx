import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ClipboardX, Plus } from 'lucide-react';
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
import { CapaPanel } from './capa-panel';
import { ContainNonconformanceModal, RaiseNonconformanceModal } from './nonconformance-modals';
import { CloseNonconformanceModal, VoidNonconformanceModal } from './nonconformance-closure-modals';
import { ContainmentOverdueBanner, RecurrenceBanner } from './quality-reports';
import { NC_NEXT_ACTIONS, NC_SEVERITIES, NC_STATUS_FILTERS } from './quality.types';
import type { Nonconformance } from './quality.types';
import { useNonconformance, useNonconformances, useSeverities } from './use-quality';

/**
 * The non-conformance register: what was found, what was done about it, and whether that worked.
 *
 * CONTAINMENT COMES BEFORE CLOSURE, always. `open → closed` is refused by the service and by
 * `ck_nc_contained_states`, because ISO 9001 §10.2(a) asks for action to control and correct the
 * non-conformity — a finding that goes straight from "found" to "closed" with nothing recorded between is
 * exactly the box-ticking the clause exists to prevent. So the screen offers Contain on an open finding and
 * Close only on a contained one.
 *
 * THE CLOSURE GATE IS THE REASON THE MODULE EXISTS. A finding whose grade `requiresCapa` cannot close until a
 * CAPA on it is verified effective — a statement about rows in ANOTHER table, so no CHECK can hold it and the
 * service enforces it. This screen does not re-implement that rule: `requiresCapa` and `verifiedCapaCount`
 * are computed by the API and returned on the row, so the register can withhold a Close it already knows
 * would be refused, and say why instead.
 *
 * THE GRADE IS REFERENCE DATA, NOT A LABEL. `requiresCapa` and `containmentDueDays` come from
 * `qms.nonconformance_severities`, which is why re-grading a finding tightens its closure requirement with no
 * code change here or in the service.
 */
export function NonconformancesPage() {
  const qc = useQueryClient();
  const list = useListState();
  const { can } = usePermissions();
  const canManage = can('nonconformance.manage');

  const [status, setStatus] = useState('');
  const [severity, setSeverity] = useState('');
  const [capaRequiredOnly, setCapaRequiredOnly] = useState(false);
  const [raising, setRaising] = useState(false);
  const [acting, setActing] = useState<{
    finding: Nonconformance;
    action: 'contain' | 'close' | 'void';
  } | null>(null);
  /**
   * The drawer's subject, held as an ID and READ BACK LIVE.
   *
   * Not the row object it was clicked from: that snapshot does not change when a CAPA is verified, so the
   * drawer went on saying a finding could not close — and withholding Close — after the gate had opened.
   * `clicked` is kept only so the drawer paints immediately on the first frame.
   */
  const [clicked, setClicked] = useState<Nonconformance | null>(null);

  const findings = useNonconformances({
    status,
    severity,
    source: '',
    processArea: '',
    capaRequiredOnly,
    search: list.search,
    limit: list.limit,
    offset: list.offset,
  });
  const live = useNonconformance(clicked?.id ?? null);
  const selected = clicked ? (live.data ?? clicked) : null;
  const severities = useSeverities();
  const invalidate = () => qc.invalidateQueries({ queryKey: ['quality'] });

  function applyFilter(apply: () => void) {
    apply();
    list.resetPaging();
  }

  /**
   * Whether closure is reachable right now, from the API's own numbers.
   *
   * Not a second implementation of the rule: `requiresCapa` is the grade's, `verifiedCapaCount` is the
   * API's count of CAPAs it verified. The screen only decides whether to offer the button.
   */
  function closureIsReachable(finding: Nonconformance): boolean {
    return (
      (NC_NEXT_ACTIONS[finding.status] ?? []).includes('close') &&
      (!finding.requiresCapa || finding.verifiedCapaCount > 0)
    );
  }

  const columns: DataTableColumn<Nonconformance>[] = [
    {
      key: 'reference',
      header: 'Reference',
      cell: (finding) => (
        <span className="font-mono text-xs font-medium text-fg">{finding.reference}</span>
      ),
    },
    {
      key: 'title',
      header: 'Finding',
      cell: (finding) => (
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-fg">{finding.title}</p>
          <p className="truncate text-xs text-fg-subtle">
            {finding.processArea} · {humanizeStatus(finding.source)}
          </p>
        </div>
      ),
    },
    {
      key: 'severity',
      header: 'Severity',
      cell: (finding) => (
        <div className="flex items-center gap-1.5">
          <Badge tone={statusTone(finding.severity)}>{humanizeStatus(finding.severity)}</Badge>
          {/* The grade's consequence, on the row, so the register reads as obligations and not adjectives. */}
          {finding.requiresCapa && <span className="text-xs text-fg-subtle">CAPA required</span>}
        </div>
      ),
    },
    {
      key: 'containment',
      header: 'Containment',
      cell: (finding) => {
        if (finding.containedAt)
          return <span className="text-xs text-fg-muted">{formatDate(finding.containedAt)}</span>;
        if (finding.status === 'void') return <span className="text-xs text-fg-subtle">—</span>;
        // The due date is the API's, from detection plus the grade's window. Overdue is the finding.
        const overdue =
          !!finding.containmentDueOn && finding.containmentDueOn < new Date().toISOString();
        return (
          <span className={`text-xs ${overdue ? 'text-warning' : 'text-fg-subtle'}`}>
            {finding.containmentDueOn ? `Due ${formatDate(finding.containmentDueOn)}` : 'Not set'}
          </span>
        );
      },
    },
    {
      key: 'capas',
      header: 'CAPAs',
      align: 'right',
      // Verified over total, because verified is the number the closure gate reads.
      cell: (finding) => (
        <span className="tabular-nums text-xs">
          {finding.verifiedCapaCount}/{finding.capaCount}
        </span>
      ),
      hideOnMobile: true,
    },
    {
      key: 'status',
      header: 'Status',
      cell: (finding) => (
        <StatusBadge tone={statusTone(finding.status)}>
          {humanizeStatus(finding.status)}
        </StatusBadge>
      ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: (finding) => {
        // From `NC_NEXT_ACTIONS`, which mirrors the service's transition map, rather than status literals
        // repeated per button — the literals are how a screen ends up offering Close on an open finding.
        const steps = NC_NEXT_ACTIONS[finding.status] ?? [];
        return (
          <RowActions>
            {canManage && steps.includes('contain') && (
              <RowAction tone="accent" onClick={() => setActing({ finding, action: 'contain' })}>
                Contain
              </RowAction>
            )}
            {/* Withheld, not disabled, while the CAPA gate is shut — the drawer says why. */}
            {canManage && steps.includes('close') && closureIsReachable(finding) && (
              <RowAction tone="success" onClick={() => setActing({ finding, action: 'close' })}>
                Close
              </RowAction>
            )}
            {canManage && steps.includes('void') && (
              <RowAction tone="danger" onClick={() => setActing({ finding, action: 'void' })}>
                Void
              </RowAction>
            )}
          </RowActions>
        );
      },
    },
  ];

  const selectedGrade = severities.data?.find((grade) => grade.code === selected?.severity);

  return (
    <>
      <RaiseNonconformanceModal
        open={raising}
        onClose={() => setRaising(false)}
        onSuccess={invalidate}
      />
      {acting?.action === 'contain' && (
        <ContainNonconformanceModal
          finding={acting.finding}
          onClose={() => setActing(null)}
          onSuccess={invalidate}
        />
      )}
      {acting?.action === 'close' && (
        <CloseNonconformanceModal
          finding={acting.finding}
          onClose={() => setActing(null)}
          onSuccess={invalidate}
        />
      )}
      {acting?.action === 'void' && (
        <VoidNonconformanceModal
          finding={acting.finding}
          onClose={() => setActing(null)}
          onSuccess={invalidate}
        />
      )}

      <ListPage
        title="Non-conformances"
        description="What was found against a requirement, what was done to contain it, and whether the corrective action worked."
        actions={
          // Reporting a finding carries no permission: anybody may raise one, which is the point of a
          // register people are willing to use.
          <Button variant="primary" onClick={() => setRaising(true)}>
            <Plus className="h-4 w-4" strokeWidth={2} />
            Raise a finding
          </Button>
        }
        search={{
          value: list.search,
          onChange: list.setSearch,
          placeholder: 'Search findings…',
        }}
        filters={
          <>
            <SegmentedControl
              label="Filter by status"
              options={NC_STATUS_FILTERS.map((option) => ({ ...option }))}
              value={status}
              onChange={(value) => applyFilter(() => setStatus(value))}
            />
            <SegmentedControl
              label="Filter by severity"
              options={[
                { value: '', label: 'Any' },
                ...NC_SEVERITIES.map((code) => ({
                  value: code,
                  label: humanizeStatus(code),
                })),
              ]}
              value={severity}
              onChange={(value) => applyFilter(() => setSeverity(value))}
            />
            <Button
              variant={capaRequiredOnly ? 'primary' : 'outline'}
              size="sm"
              aria-pressed={capaRequiredOnly}
              onClick={() => applyFilter(() => setCapaRequiredOnly(!capaRequiredOnly))}
            >
              CAPA required
            </Button>
          </>
        }
        pageInfo={findings.data?.pageInfo}
        onOffsetChange={list.goToOffset}
        noun="finding"
      >
        <div className="mb-4 flex flex-col gap-2">
          <RecurrenceBanner />
          <ContainmentOverdueBanner />
        </div>

        <DataTable
          columns={columns}
          rows={findings.data?.data}
          isLoading={findings.isLoading}
          isError={findings.isError}
          errorMessage="Failed to load the non-conformance register."
          emptyMessage="No findings match these filters"
          emptyIcon={ClipboardX}
          emptyAction={
            list.search ? undefined : (
              <Button variant="primary" size="sm" onClick={() => setRaising(true)}>
                <Plus className="h-3.5 w-3.5" /> Raise a finding
              </Button>
            )
          }
          onRowClick={setClicked}
          isRowActive={(finding) => finding.id === selected?.id}
        />
      </ListPage>

      <EntityDetailPanel
        open={!!selected}
        onClose={() => setClicked(null)}
        title={selected?.title ?? 'Finding'}
        description={selected?.reference}
        headerActions={
          selected && canManage && selected.status === 'open' ? (
            <PanelAction
              tone="accent"
              onClick={() => setActing({ finding: selected, action: 'contain' })}
            >
              Contain
            </PanelAction>
          ) : selected && canManage && closureIsReachable(selected) ? (
            <PanelAction
              tone="success"
              onClick={() => setActing({ finding: selected, action: 'close' })}
            >
              Close
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
                  label: 'Severity',
                  value: (
                    <Badge tone={statusTone(selected.severity)}>
                      {humanizeStatus(selected.severity)}
                    </Badge>
                  ),
                },
                {
                  label: 'Closure requirement',
                  wide: true,
                  // Reference data read back, not a rule restated: the grade decides, and the API counts.
                  value: selectedGrade
                    ? selectedGrade.requiresCapa
                      ? `A CAPA verified effective is required. ${selected.verifiedCapaCount} of ${selected.capaCount} CAPA(s) verified.`
                      : 'Can be closed on containment alone at this grade.'
                    : orDash(null),
                },
                { label: 'Requirement', wide: true, value: selected.requirement },
                { label: 'Description', wide: true, value: selected.description },
                { label: 'Process area', value: selected.processArea },
                { label: 'Source', value: humanizeStatus(selected.source) },
                { label: 'Detected', value: formatDate(selected.detectedAt) },
                {
                  label: 'Containment due',
                  value: selected.containmentDueOn
                    ? formatDate(selected.containmentDueOn)
                    : `${orDash(selectedGrade?.containmentDueDays)} day(s) from detection`,
                },
                {
                  label: 'Owner',
                  // The NAME. This field's only job is to say who is accountable for the failure, and
                  // thirty-six characters of uuid answered that with nothing.
                  value: (
                    <span>
                      {orDash(selected.ownerName)}
                      {/* The uuid stays here, secondary: the drawer has room, and it is what somebody
                          quotes in a ticket. */}
                      <span className="ml-2 font-mono text-2xs text-fg-subtle">
                        {selected.ownerId}
                      </span>
                    </span>
                  ),
                },
                // Each of these appears only once it has happened: an empty "containment action" line on an
                // open finding reads as a gap in the record rather than a step not yet taken.
                ...(selected.containedAt
                  ? [
                      { label: 'Contained', value: formatDate(selected.containedAt) },
                      {
                        label: 'Containment action',
                        wide: true,
                        value: orDash(selected.containmentAction),
                      },
                    ]
                  : []),
                ...(selected.closedAt
                  ? [
                      { label: 'Closed', value: formatDate(selected.closedAt) },
                      { label: 'Closure note', wide: true, value: orDash(selected.closureNote) },
                    ]
                  : []),
                ...(selected.voidReason
                  ? [{ label: 'Voided because', wide: true, value: selected.voidReason }]
                  : []),
              ]
            : []
        }
        activity={
          selected ? { resourceId: selected.id, resourceType: 'nonconformance' } : undefined
        }
      >
        {selected && (
          <SlideOverSection title={`CAPAs (${selected.capaCount})`}>
            {/* The gate stated where the work to open it is: a contained finding that cannot close is the
                register's most common stuck state, and this is the only place that says why. */}
            {selected.status === 'contained' && !closureIsReachable(selected) && (
              <p className="mb-2 text-xs text-warning">
                Contained, but not closable: this grade needs a CAPA verified effective, and none is
                yet.
              </p>
            )}
            <CapaPanel finding={selected} />
          </SlideOverSection>
        )}
      </EntityDetailPanel>
    </>
  );
}
