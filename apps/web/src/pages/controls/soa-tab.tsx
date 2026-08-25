import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, ClipboardList, ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/shared/api/client';
import { apiErrorMessage } from '@/shared/api/errors';
import {
  Badge,
  DataTable,
  PaginationFooter,
  RowAction,
  RowActions,
  SegmentedControl,
  StatCard,
  StatGrid,
  StatusBadge,
  TabToolbar,
  humanizeStatus,
  statusTone,
  type DataTableColumn,
} from '@/shared/ui';
import { useListState } from '@/shared/hooks/use-list-state';
import { usePermissions } from '@/shared/hooks/use-permissions';
import { formatDate, orDash } from '@/shared/lib/format';
import { SetSoaEntryModal } from './control-modals';
import { SOA_STATUS_FILTERS } from './control.types';
import { useSoa, useSoaCoverage, useUntreatedRisks } from './use-controls';
import type { SoaRow } from './control.types';

/**
 * The Statement of Applicability — the document an ISO 27001 audit opens with.
 *
 * UNDECIDED IS NOT ZERO. The coverage tiles count controls with NO entry separately, because omitting a
 * control from the SoA is not the same as excluding it: one is a decision with a reason attached, the
 * other is a control nobody considered. That distinction is the finding auditors look for, so it gets a
 * tile rather than being folded into "not implemented".
 *
 * UNTREATED RISKS sit on this screen deliberately. A risk whose decision was "mitigate" and which no
 * control implements is a plan with no mechanism — visible from the register only as an absence, and
 * computed here by the API as a join across risks, links and entries.
 */
export function SoaTab() {
  const qc = useQueryClient();
  const list = useListState();
  const { can } = usePermissions();
  const canManage = can('control.manage');

  const [status, setStatus] = useState('');
  const [theme, setTheme] = useState('');
  const [editing, setEditing] = useState<SoaRow | null>(null);

  const soa = useSoa({ status, theme, limit: list.limit, offset: list.offset });
  const coverage = useSoaCoverage();
  const untreated = useUntreatedRisks();
  const invalidate = () => qc.invalidateQueries({ queryKey: ['controls'] });

  async function markReviewed(row: SoaRow) {
    const { error } = await api.POST('/v1/controls/soa/{controlId}/reviewed', {
      params: { path: { controlId: row.controlId } },
      // The endpoint takes an OPTIONAL next review date; sending none means "reviewed today, keep the
      // schedule the entry already has" rather than silently clearing it.
      body: {},
    });
    if (error) {
      toast.error(apiErrorMessage(error, 'Failed to record the review.'));
      return;
    }
    toast.success('Review recorded');
    invalidate();
  }

  const columns: DataTableColumn<SoaRow>[] = [
    {
      key: 'reference',
      header: 'Control',
      cell: (row) => (
        <div className="min-w-0">
          <p className="truncate font-mono text-xs font-medium text-fg">{row.controlReference}</p>
          <p className="truncate text-xs text-fg-subtle">{row.controlTitle}</p>
        </div>
      ),
    },
    {
      key: 'theme',
      header: 'Theme',
      cell: (row) => <Badge>{humanizeStatus(row.controlTheme)}</Badge>,
      hideOnMobile: true,
    },
    {
      key: 'applicable',
      header: 'In scope',
      // Both directions are decisions, so both are words. A blank here would read as undecided, which is
      // a third state this table does not contain.
      cell: (row) =>
        row.applicable ? (
          <Badge tone="green">Applicable</Badge>
        ) : (
          <Badge tone="neutral">Excluded</Badge>
        ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (row) => (
        <StatusBadge tone={statusTone(row.status)}>{humanizeStatus(row.status)}</StatusBadge>
      ),
    },
    {
      key: 'owner',
      header: 'Owner',
      // The NAME, not `ownerId`. This is the document an audit opens with and this column is asked
      // "who owns this control" of every line of it — a uuid per row answered that with nothing. The
      // id is dropped outright rather than kept alongside: a list cell has no room for both, and the
      // drawer is where an id gets quoted. `null` here is still "no name for a real owner", which is
      // NOT the same as the unassigned state below, so the two branches stay separate.
      cell: (row) =>
        row.ownerId ? (
          <span className="text-xs text-fg-muted">{orDash(row.ownerName)}</span>
        ) : (
          <span className="text-xs text-fg-subtle">Unassigned</span>
        ),
      hideOnMobile: true,
    },
    {
      key: 'reviewed',
      header: 'Last reviewed',
      cell: (row) => (
        <div className="text-xs">
          <p className="text-fg-muted">{formatDate(row.lastReviewedAt)}</p>
          <p className="text-fg-subtle">due {orDash(formatDate(row.reviewDueOn))}</p>
        </div>
      ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: (row) =>
        canManage ? (
          <RowActions>
            <RowAction tone="accent" onClick={() => setEditing(row)}>
              Edit
            </RowAction>
            {/* Reviewing only means something for a control that is IN scope: re-confirming an exclusion
                is a change of justification, which is the edit above. */}
            {row.applicable && (
              <RowAction tone="success" onClick={() => void markReviewed(row)}>
                Reviewed
              </RowAction>
            )}
          </RowActions>
        ) : null,
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      {editing && (
        <SetSoaEntryModal
          control={{
            id: editing.controlId,
            reference: editing.controlReference,
            title: editing.controlTitle,
          }}
          entry={editing}
          onClose={() => setEditing(null)}
          onSuccess={invalidate}
        />
      )}

      <StatGrid>
        <StatCard
          label="Undecided"
          value={coverage.data?.undecided ?? 0}
          hint={`of ${coverage.data?.totalControls ?? 0} controls`}
          icon={ShieldAlert}
          tone="red"
          alert
          loading={coverage.isLoading}
        />
        <StatCard
          label="Implemented"
          value={coverage.data?.implemented ?? 0}
          icon={CheckCircle2}
          tone="green"
          loading={coverage.isLoading}
        />
        <StatCard
          label="Partial"
          value={coverage.data?.partiallyImplemented ?? 0}
          tone="amber"
          loading={coverage.isLoading}
        />
        <StatCard
          label="Excluded"
          value={coverage.data?.excluded ?? 0}
          hint="with a justification"
          loading={coverage.isLoading}
        />
      </StatGrid>

      {/* Only when there ARE untreated risks: a permanently visible empty panel trains people to ignore
          the place the finding will appear. */}
      {(untreated.data?.length ?? 0) > 0 && (
        <div className="rounded-lg border border-danger-bg bg-danger-bg/40 px-3 py-2.5">
          <p className="text-xs font-medium text-danger">
            {untreated.data?.length} risk(s) are being mitigated by no control
          </p>
          <ul className="mt-1 flex flex-col gap-0.5">
            {(untreated.data ?? []).slice(0, 5).map((risk) => (
              <li key={risk.riskId} className="text-xs text-fg-muted">
                <span className="font-mono">{risk.reference}</span> · {risk.title}
                <span className="text-fg-subtle">
                  {' '}
                  (residual {orDash(risk.residualScore ?? risk.inherentScore)})
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <TabToolbar
        filter={
          <div className="flex flex-wrap items-center gap-2">
            <SegmentedControl
              label="Filter by status"
              options={SOA_STATUS_FILTERS.map((option) => ({ ...option }))}
              value={status}
              onChange={(value) => {
                setStatus(value);
                list.resetPaging();
              }}
            />
            <SegmentedControl
              label="Filter by theme"
              options={[
                { value: '', label: 'All themes' },
                { value: 'organizational', label: 'Org' },
                { value: 'people', label: 'People' },
                { value: 'physical', label: 'Physical' },
                { value: 'technological', label: 'Tech' },
              ]}
              value={theme}
              onChange={(value) => {
                setTheme(value);
                list.resetPaging();
              }}
            />
          </div>
        }
      />

      <DataTable
        columns={columns}
        rows={soa.data?.data}
        isLoading={soa.isLoading}
        isError={soa.isError}
        errorMessage="Failed to load the Statement of Applicability."
        emptyMessage="No decided controls match these filters"
        emptyIcon={ClipboardList}
      />

      <PaginationFooter
        pageInfo={soa.data?.pageInfo}
        onOffsetChange={list.goToOffset}
        noun="control"
      />
    </div>
  );
}
