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
import { AssignRoleModal, RoleModal } from './role-modals';
import { rankNamesById, useJobRanks } from './use-job-ranks';
import type { Role, RoleAssignment } from './role.types';

/**
 * Roles and headcount — the first screen for a module that had none.
 *
 * WHY A SCREEN AT ALL. `roles` has been in the API since the EMS depth work: contracts reference a
 * role, training requirements hang off one, and a performance review freezes the role it judged.
 * Until now the only way to create one was a POST by hand, which means the three features that depend
 * on roles were unusable through the UI.
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

function useRoles(search: string, status: string, limit: number, offset: number) {
  return useQuery({
    queryKey: ['roles', 'list', search, status, limit, offset],
    queryFn: async () => {
      const { data, error } = await api.GET('/v1/roles', {
        params: {
          query: {
            search: search || undefined,
            status: (status || undefined) as 'active' | 'frozen' | 'closed' | undefined,
            limit,
            offset,
          },
        },
      });
      if (error || !data) throw new Error('Failed to load roles');
      return data;
    },
  });
}

function useAssignments(roleId: string | null) {
  return useQuery({
    queryKey: ['roles', 'assignments', roleId],
    enabled: !!roleId,
    queryFn: async () => {
      const { data, error } = await api.GET('/v1/roles/{id}/assignments', {
        params: { path: { id: roleId! } },
      });
      if (error || !data) throw new Error('Failed to load assignments');
      return data;
    },
  });
}

export function RolesPage() {
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = useState('active');
  const [editing, setEditing] = useState<Role | undefined>();
  const [creating, setCreating] = useState(false);
  const [assigning, setAssigning] = useState<Role | null>(null);
  const [selected, setSelected] = useState<Role | null>(null);
  /*
   * GATED ON THE PERMISSION THE API ENFORCES. Every write route here carries
   * `@RequirePermission('role.manage')`, and this page offered Create, Edit, Assign and End to
   * anyone who could READ a role — four affordances that answer 403 for a `role.read` holder.
   */
  const canManage = usePermissions().can('role.manage');
  const [endingId, setEndingId] = useState<string | null>(null);
  const list = useListState();

  const rankNames = rankNamesById(useJobRanks().data);
  const roles = useRoles(list.search, statusFilter, list.limit, list.offset);
  const assignments = useAssignments(selected?.id ?? null);
  const invalidate = () => qc.invalidateQueries({ queryKey: ['roles'] });

  async function endAssignment(id: string) {
    const { error } = await api.PATCH('/v1/roles/assignments/{id}/end', {
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
    void qc.invalidateQueries({ queryKey: ['roles', 'assignments'] });
  }

  const columns: DataTableColumn<Role>[] = [
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
    {
      key: 'rank',
      header: 'Rank',
      cell: (p) => orDash(p.rankId ? rankNames.get(p.rankId) : null),
      hideOnMobile: true,
    },
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
      {creating && <RoleModal open onClose={() => setCreating(false)} onSuccess={invalidate} />}
      {editing && (
        <RoleModal
          open
          role={editing}
          onClose={() => setEditing(undefined)}
          onSuccess={invalidate}
        />
      )}
      {assigning && (
        <AssignRoleModal
          role={assigning}
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
        title="Roles"
        description="Approved roles, their headcount, and who occupies them."
        actions={
          canManage ? (
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" strokeWidth={2} />
              New role
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
        pageInfo={roles.data?.pageInfo}
        onOffsetChange={list.goToOffset}
        noun="roles"
      >
        <DataTable
          columns={columns}
          rows={roles.data?.data as Role[] | undefined}
          isLoading={roles.isLoading}
          isError={roles.isError}
          errorMessage="Failed to load roles."
          emptyMessage={list.search ? 'No roles match that search' : 'No roles yet'}
          emptyIcon={Briefcase}
          emptyAction={
            list.search || !canManage ? undefined : (
              <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
                <Plus className="h-3.5 w-3.5" /> Create your first role
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
        title={selected?.title ?? 'Role'}
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
                {
                  label: 'Rank',
                  value: selected.rankId ? rankNames.get(selected.rankId) : null,
                },
                { label: 'Headcount', value: `${selected.filled} of ${selected.headcount} filled` },
                { label: 'Vacancies', value: selected.vacancies },
                { label: 'Created', value: formatDate(selected.createdAt) },
                { label: 'Description', value: selected.description, wide: true },
              ]
            : []
        }
        activity={selected ? { resourceId: selected.id, resourceType: 'role' } : undefined}
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
                  cell: (a: RoleAssignment) => (
                    <span className="text-xs">{orDash(a.employeeName)}</span>
                  ),
                },
                {
                  key: 'from',
                  header: 'From',
                  cell: (a: RoleAssignment) => formatDate(a.effectiveFrom),
                },
                {
                  key: 'to',
                  header: 'To',
                  cell: (a: RoleAssignment) =>
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
                  cell: (a: RoleAssignment) =>
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
