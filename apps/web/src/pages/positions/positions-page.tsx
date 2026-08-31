import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Briefcase, Pencil, Plus, UserPlus } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/shared/api/client';
import { apiErrorMessage } from '@/shared/api/errors';
import {
  Button,
  ConfirmDialog,
  DataTable,
  EntityDetailPanel,
  ListPage,
  SegmentedControl,
  SlideOverSection,
  StatusBadge,
  Tooltip,
  humanizeStatus,
  statusTone,
  type DataTableColumn,
} from '@/shared/ui';
import { useListState } from '@/shared/hooks/use-list-state';
import { usePermissions } from '@/shared/hooks/use-permissions';
import { formatDate, orDash, todayIso } from '@/shared/lib/format';
import { AssignPositionModal, PositionModal } from './position-modals';
import type { Position, PositionAssignment } from './position.types';

/**
 * Positions and headcount — the first screen for a module that had none.
 *
 * WHY A SCREEN AT ALL. `positions` has been in the API since the EMS depth work: contracts reference a
 * position, training requirements hang off one, and a performance review freezes the position it judged.
 * Until now the only way to create one was a POST by hand, which means the three features that depend
 * on positions were unusable through the UI.
 *
 * THE HEADCOUNT COLUMN IS THE POINT. `filled` counts OPEN assignments and `vacancies` is
 * `headcount - filled` floored at zero — both computed by the API, because a reduced headcount must not
 * report negative vacancies and a client doing that subtraction would get it wrong differently.
 */

const STATUS_FILTERS = [
  { value: '', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'frozen', label: 'Frozen' },
  { value: 'closed', label: 'Closed' },
];

function usePositions(search: string, status: string, limit: number, offset: number) {
  return useQuery({
    queryKey: ['positions', 'list', search, status, limit, offset],
    queryFn: async () => {
      const { data, error } = await api.GET('/v1/positions', {
        params: {
          query: {
            search: search || undefined,
            status: (status || undefined) as 'active' | 'frozen' | 'closed' | undefined,
            limit,
            offset,
          },
        },
      });
      if (error || !data) throw new Error('Failed to load positions');
      return data;
    },
  });
}

function useAssignments(positionId: string | null) {
  return useQuery({
    queryKey: ['positions', 'assignments', positionId],
    enabled: !!positionId,
    queryFn: async () => {
      const { data, error } = await api.GET('/v1/positions/{id}/assignments', {
        params: { path: { id: positionId! } },
      });
      if (error || !data) throw new Error('Failed to load assignments');
      return data;
    },
  });
}

export function PositionsPage() {
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = useState('active');
  const [editing, setEditing] = useState<Position | undefined>();
  const [creating, setCreating] = useState(false);
  const [assigning, setAssigning] = useState<Position | null>(null);
  const [selected, setSelected] = useState<Position | null>(null);
  /*
   * GATED ON THE PERMISSION THE API ENFORCES. Every write route here carries
   * `@RequirePermission('position.manage')`, and this page offered Create, Edit, Assign and End to
   * anyone who could READ a position — four affordances that answer 403 for a `position.read` holder.
   */
  const canManage = usePermissions().can('position.manage');
  const [endingId, setEndingId] = useState<string | null>(null);
  const list = useListState();

  const positions = usePositions(list.search, statusFilter, list.limit, list.offset);
  const assignments = useAssignments(selected?.id ?? null);
  const invalidate = () => qc.invalidateQueries({ queryKey: ['positions'] });

  async function endAssignment(id: string) {
    const { error } = await api.PATCH('/v1/positions/assignments/{id}/end', {
      params: { path: { id } },
      // Ends TODAY. A different date is a correction, which belongs on the history screen rather than
      // behind a confirm dialog that has no field for it.
      body: { effectiveTo: todayIso(), endReason: 'Ended from the UI' },
    });
    setEndingId(null);
    if (error) {
      toast.error(apiErrorMessage(error, 'Failed to end the assignment.'));
      return;
    }
    toast.success('Assignment ended');
    invalidate();
    void qc.invalidateQueries({ queryKey: ['positions', 'assignments'] });
  }

  const columns: DataTableColumn<Position>[] = [
    {
      key: 'code',
      header: 'Code',
      cell: (p) => <span className="font-mono text-xs font-medium text-fg">{p.code}</span>,
    },
    {
      key: 'title',
      header: 'Title',
      cell: (p) => (
        <div className="min-w-0">
          <p className="truncate font-medium text-fg">{p.title}</p>
          <p className="truncate text-xs text-fg-subtle">{p.department}</p>
        </div>
      ),
    },
    { key: 'level', header: 'Level', cell: (p) => orDash(p.level), hideOnMobile: true },
    {
      key: 'headcount',
      header: 'Filled',
      align: 'right',
      // "2 / 3" reads as occupancy where two separate columns read as two unrelated numbers.
      cell: (p) => (
        <span className="tabular-nums">
          {p.filled} / {p.headcount}
        </span>
      ),
    },
    {
      key: 'vacancies',
      header: 'Vacancies',
      align: 'right',
      cell: (p) => (
        <span className={p.vacancies > 0 ? 'font-medium text-warning' : 'text-fg-muted'}>
          {p.vacancies}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (p) => (
        <StatusBadge tone={statusTone(p.status)}>{humanizeStatus(p.status)}</StatusBadge>
      ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: (p) => (
        <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
          {/* `Button` with the kit's icon size, not a bare `<button>`: the primitive already covers
              this — `size="icon-sm"` exists — and the FE ratchet counts raw buttons for exactly this
              reason. `aria-label` is not optional on an icon-only control. */}
          {canManage && p.status === 'active' && (
            <Tooltip content="Assign">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Assign somebody to ${p.title}`}
                onClick={() => setAssigning(p)}
              >
                <UserPlus className="h-4 w-4" strokeWidth={2} />
              </Button>
            </Tooltip>
          )}
          {canManage && (
            <Tooltip content="Edit">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Edit ${p.title}`}
                onClick={() => setEditing(p)}
              >
                <Pencil className="h-4 w-4" strokeWidth={2} />
              </Button>
            </Tooltip>
          )}
        </div>
      ),
    },
  ];

  return (
    <>
      {creating && <PositionModal open onClose={() => setCreating(false)} onSuccess={invalidate} />}
      {editing && (
        <PositionModal
          open
          position={editing}
          onClose={() => setEditing(undefined)}
          onSuccess={invalidate}
        />
      )}
      {assigning && (
        <AssignPositionModal
          position={assigning}
          onClose={() => setAssigning(null)}
          onSuccess={invalidate}
        />
      )}

      <ConfirmDialog
        open={!!endingId}
        onCancel={() => setEndingId(null)}
        onConfirm={() => endingId && endAssignment(endingId)}
        variant="warning"
        title="End this assignment?"
        description="The slot frees up immediately. The assignment stays in the employee's history — it is closed, not deleted."
        confirmLabel="End assignment"
      />

      <ListPage
        title="Positions"
        description="Approved roles, their headcount, and who occupies them."
        actions={
          canManage ? (
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" strokeWidth={2} />
              New position
            </Button>
          ) : undefined
        }
        search={{
          value: list.search,
          onChange: list.setSearch,
          placeholder: 'Search code, title or department…',
        }}
        filters={
          <SegmentedControl
            label="Filter by status"
            options={STATUS_FILTERS}
            value={statusFilter}
            onChange={(value) => {
              setStatusFilter(value);
              list.resetPaging();
            }}
          />
        }
        pageInfo={positions.data?.pageInfo}
        onOffsetChange={list.goToOffset}
        noun="positions"
      >
        <DataTable
          columns={columns}
          rows={positions.data?.data as Position[] | undefined}
          isLoading={positions.isLoading}
          isError={positions.isError}
          errorMessage="Failed to load positions."
          emptyMessage={list.search ? 'No positions match that search' : 'No positions yet'}
          emptyIcon={Briefcase}
          emptyAction={
            list.search || !canManage ? undefined : (
              <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
                <Plus className="h-3.5 w-3.5" /> New position
              </Button>
            )
          }
          onRowClick={setSelected}
          isRowActive={(p) => p.id === selected?.id}
        />
      </ListPage>

      <EntityDetailPanel
        open={!!selected}
        onClose={() => setSelected(null)}
        width="lg"
        title={selected?.title ?? 'Position'}
        description={selected ? `${selected.code} · ${selected.department}` : undefined}
        items={
          selected
            ? [
                {
                  label: 'Code',
                  value: <span className="font-mono text-xs">{selected.code}</span>,
                },
                {
                  label: 'Status',
                  value: (
                    <StatusBadge tone={statusTone(selected.status)}>
                      {humanizeStatus(selected.status)}
                    </StatusBadge>
                  ),
                },
                { label: 'Department', value: selected.department },
                { label: 'Level', value: selected.level },
                { label: 'Headcount', value: `${selected.filled} of ${selected.headcount} filled` },
                { label: 'Vacancies', value: selected.vacancies },
                { label: 'Created', value: formatDate(selected.createdAt) },
                { label: 'Description', value: selected.description, wide: true },
              ]
            : []
        }
        activity={selected ? { resourceId: selected.id, resourceType: 'position' } : undefined}
      >
        {selected && (
          <SlideOverSection title="Assignments">
            {/* Current assignments first: `effectiveTo === null` is what "current" means, and a closed
                assignment is history rather than occupancy. */}
            <DataTable
              columns={[
                {
                  key: 'employee',
                  header: 'Employee',
                  // Who has held the role, by name. The history is opened to read exactly that.
                  cell: (a: PositionAssignment) => (
                    <span className="text-xs">{orDash(a.employeeName)}</span>
                  ),
                },
                {
                  key: 'from',
                  header: 'From',
                  cell: (a: PositionAssignment) => formatDate(a.effectiveFrom),
                },
                {
                  key: 'to',
                  header: 'To',
                  cell: (a: PositionAssignment) =>
                    a.effectiveTo ? (
                      formatDate(a.effectiveTo)
                    ) : (
                      <StatusBadge tone="green">Current</StatusBadge>
                    ),
                },
                {
                  key: 'actions',
                  header: '',
                  align: 'right',
                  cell: (a: PositionAssignment) =>
                    a.effectiveTo || !canManage ? null : (
                      <Button variant="outline" size="sm" onClick={() => setEndingId(a.id)}>
                        End
                      </Button>
                    ),
                },
              ]}
              rows={assignments.data}
              isLoading={assignments.isLoading}
              isError={assignments.isError}
              errorMessage="Failed to load assignments."
              emptyMessage="Nobody assigned yet"
              emptyIcon={UserPlus}
              emptyAction={
                !canManage ? undefined : (
                  <Button variant="primary" size="sm" onClick={() => setAssigning(selected)}>
                    <UserPlus className="h-3.5 w-3.5" /> Assign somebody
                  </Button>
                )
              }
            />
          </SlideOverSection>
        )}
      </EntityDetailPanel>
    </>
  );
}
