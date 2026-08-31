import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Archive, Pencil, Plus, ShieldCheck } from 'lucide-react';
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
  type DataTableColumn,
  PanelState,
} from '@/shared/ui';
import { useListState } from '@/shared/hooks/use-list-state';
import { usePermissions } from '@/shared/hooks/use-permissions';
import { formatDate, orDash } from '@/shared/lib/format';
import { CreateControlModal, EditControlModal, SetSoaEntryModal } from './control-modals';
import { useControlRisks, useControls } from './use-controls';
import type { Control } from './control.types';

/**
 * The control catalogue: Annex A as it arrived, plus whatever this organisation added.
 *
 * DECIDING A CONTROL HAPPENS HERE TOO. The SoA tab lists controls that have already been decided — which
 * means the ones that have NOT cannot be reached from it. That is the gap the coverage tile counts as
 * "undecided", so the catalogue offers "Decide" on any control without an entry: the report and the way
 * to act on it are one click apart rather than on separate screens.
 *
 * RETIRING IS NOT DELETING. A retired control keeps its SoA history and its risk links, because an audit
 * asks what was in place at a point in time. It only stops being available for new decisions.
 */
export function CatalogueTab() {
  const qc = useQueryClient();
  const list = useListState();
  const { can } = usePermissions();
  const canManage = can('control.manage');

  const [theme, setTheme] = useState('');
  const [scope, setScope] = useState('active');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Control | null>(null);
  const [deciding, setDeciding] = useState<Control | null>(null);
  const [retiring, setRetiring] = useState<Control | null>(null);
  const [selected, setSelected] = useState<Control | null>(null);

  const controls = useControls({
    theme,
    source: '',
    includeRetired: scope === 'all',
    limit: list.limit,
    offset: list.offset,
  });
  const linkedRisks = useControlRisks(selected?.id ?? null);
  const invalidate = () => qc.invalidateQueries({ queryKey: ['controls'] });

  async function retire() {
    if (!retiring) return;
    const { error } = await api.POST('/v1/controls/{id}/retire', {
      params: { path: { id: retiring.id } },
    });
    setRetiring(null);
    if (error) {
      toast.error(apiErrorMessage(error, 'Failed to retire the control.'));
      return;
    }
    toast.success('Control retired');
    invalidate();
  }

  const columns: DataTableColumn<Control>[] = [
    {
      key: 'reference',
      header: 'Reference',
      cell: (control) => (
        <span className="font-mono text-xs font-medium text-fg">{control.reference}</span>
      ),
    },
    {
      key: 'title',
      header: 'Control',
      cell: (control) => (
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-fg">{control.title}</p>
          <p className="truncate text-xs text-fg-subtle">{orDash(control.description)}</p>
        </div>
      ),
    },
    {
      key: 'theme',
      header: 'Theme',
      cell: (control) => <Badge>{humanizeStatus(control.theme)}</Badge>,
    },
    {
      key: 'source',
      header: 'Source',
      // Where a control came from decides whether it can be edited at all: the standard's text is not
      // ours to rewrite.
      cell: (control) => (
        <Badge tone={control.source === 'annex_a' ? 'blue' : 'neutral'}>
          {control.source === 'annex_a' ? 'Annex A' : 'Custom'}
        </Badge>
      ),
      hideOnMobile: true,
    },
    {
      key: 'status',
      header: 'Status',
      cell: (control) =>
        control.retiredAt ? (
          <StatusBadge tone="neutral">Retired</StatusBadge>
        ) : (
          <StatusBadge tone="green">Available</StatusBadge>
        ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: (control) =>
        canManage ? (
          <RowActions>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setDeciding(control)}
              disabled={!!control.retiredAt}
            >
              Decide
            </Button>
            {control.source === 'custom' && !control.retiredAt && (
              <Tooltip content="Edit">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Edit ${control.title}`}
                  onClick={() => setEditing(control)}
                >
                  <Pencil className="h-3.5 w-3.5" strokeWidth={2} />
                </Button>
              </Tooltip>
            )}
            {!control.retiredAt && (
              <Tooltip content="Retire">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Retire ${control.title}`}
                  onClick={() => setRetiring(control)}
                >
                  <Archive className="h-3.5 w-3.5" strokeWidth={2} />
                </Button>
              </Tooltip>
            )}
          </RowActions>
        ) : null,
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <CreateControlModal
        open={creating}
        onClose={() => setCreating(false)}
        onSuccess={invalidate}
      />
      {editing && (
        <EditControlModal
          control={editing}
          onClose={() => setEditing(null)}
          onSuccess={invalidate}
        />
      )}
      {deciding && (
        <SetSoaEntryModal
          control={deciding}
          // No entry passed: this is the "undecided" path, so the form starts empty rather than
          // pretending to edit something that does not exist.
          entry={null}
          onClose={() => setDeciding(null)}
          onSuccess={invalidate}
        />
      )}

      <ConfirmDialog
        open={!!retiring}
        onCancel={() => setRetiring(null)}
        onConfirm={retire}
        title="Retire this control?"
        description="It stops being available for new SoA decisions and risk links. Its history and existing links are kept, because an audit asks what was in place at the time."
        confirmLabel="Retire control"
      />

      <TabToolbar
        filter={
          <div className="flex flex-wrap items-center gap-2">
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
            <SegmentedControl
              label="Filter by status"
              options={[
                { value: 'active', label: 'Available' },
                { value: 'all', label: 'Incl. retired' },
              ]}
              value={scope}
              onChange={(value) => {
                setScope(value);
                list.resetPaging();
              }}
            />
          </div>
        }
        action={
          canManage ? (
            <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
              <Plus className="h-3.5 w-3.5" strokeWidth={2} />
              New control
            </Button>
          ) : undefined
        }
      />

      <DataTable
        columns={columns}
        rows={controls.data?.data}
        isLoading={controls.isLoading}
        isError={controls.isError}
        errorMessage="Failed to load the control catalogue."
        emptyMessage="No controls match these filters"
        emptyIcon={ShieldCheck}
        emptyAction={
          list.search || !canManage ? undefined : (
            <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
              <Plus className="h-3.5 w-3.5" /> New control
            </Button>
          )
        }
        onRowClick={setSelected}
        isRowActive={(control) => control.id === selected?.id}
      />

      <PaginationFooter
        pageInfo={controls.data?.pageInfo}
        onOffsetChange={list.goToOffset}
        noun="control"
      />

      <EntityDetailPanel
        open={!!selected}
        onClose={() => setSelected(null)}
        title={selected?.title ?? 'Control'}
        description={selected?.reference}
        headerActions={
          selected && canManage && !selected.retiredAt ? (
            <PanelAction tone="accent" onClick={() => setDeciding(selected)}>
              Decide
            </PanelAction>
          ) : undefined
        }
        items={
          selected
            ? [
                {
                  label: 'Theme',
                  value: <Badge>{humanizeStatus(selected.theme)}</Badge>,
                },
                {
                  label: 'Source',
                  value: selected.source === 'annex_a' ? 'Annex A' : 'Custom',
                },
                {
                  label: 'Status',
                  value: selected.retiredAt
                    ? `Retired ${formatDate(selected.retiredAt)}`
                    : 'Available',
                },
                {
                  label: 'Description',
                  wide: true,
                  value: selected.description ? (
                    <p className="whitespace-pre-wrap text-sm text-fg-muted">
                      {selected.description}
                    </p>
                  ) : (
                    orDash(null)
                  ),
                },
              ]
            : []
        }
        activity={selected ? { resourceId: selected.id, resourceType: 'control' } : undefined}
      >
        {selected && (
          <SlideOverSection title="Risks this control answers">
            {/* The audit question, named. A control with no risk behind it is either inherited from the
                standard or unnecessary — and this is where somebody notices. Through `PanelState`
                because it had NO error branch: a failed load rendered nothing at all, and the empty
                test `!isLoading && length === 0` was true on failure too — so a broken request
                claimed the control had no risks behind it, which is the audit finding it exists to
                surface. */}
            <PanelState
              query={linkedRisks}
              count={linkedRisks.data?.length ?? 0}
              empty="No risks linked — nothing in the register currently justifies this control"
              error="Failed to load the risks linked to this control."
            />
            <div className="flex flex-col gap-1.5">
              {(linkedRisks.data ?? []).map((risk) => (
                <div
                  key={risk.id}
                  className="rounded-md border border-border bg-surface px-2.5 py-1.5"
                >
                  <p className="truncate font-mono text-xs font-medium text-fg">{risk.reference}</p>
                  <p className="truncate text-xs text-fg-muted">{risk.title}</p>
                </div>
              ))}
            </div>
          </SlideOverSection>
        )}
      </EntityDetailPanel>
    </div>
  );
}
