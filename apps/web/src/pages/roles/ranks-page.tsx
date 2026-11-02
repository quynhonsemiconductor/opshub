import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Layers, Pencil, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/shared/api/client';
import { apiErrorMessage } from '@/shared/api/errors';
import {
  Button,
  ConfirmDialog,
  DataTable,
  ListPage,
  Tooltip,
  type DataTableColumn,
} from '@/shared/ui';
import { usePermissions } from '@/shared/hooks/use-permissions';
import { RankModal } from './rank-modals';
import { wfhWeeklyDaysOf } from './rank-benefits.helpers';
import { JOB_RANKS_QUERY_KEY, useJobRanks } from './use-job-ranks';
import type { JobRank } from './role.types';

/**
 * Job ranks and what each one entitles its holders to.
 *
 * A rank is the seniority a role carries. The one benefit today is the weekly work-from-home allowance,
 * which the WFH request form checks against: an employee whose rank has none cannot file. Reading needs
 * `role.read`; creating, editing and deleting need `role.manage`, the permission the API enforces on every
 * write route here, so a reader is not offered controls that answer 403.
 *
 * A rank that a role still carries cannot be deleted; the API refuses with its own sentence, which is
 * shown as it is.
 */
export function RanksPage() {
  const qc = useQueryClient();
  const canManage = usePermissions().can('role.manage');
  const ranks = useJobRanks();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<JobRank | undefined>();
  const [pendingDelete, setPendingDelete] = useState<JobRank | null>(null);
  const [deleting, setDeleting] = useState(false);

  const invalidate = () => qc.invalidateQueries({ queryKey: JOB_RANKS_QUERY_KEY });

  async function deleteRank() {
    if (!pendingDelete) return;
    setDeleting(true);
    const { error } = await api.DELETE('/v1/job-ranks/{id}', {
      params: { path: { id: pendingDelete.id } },
    });
    setDeleting(false);
    setPendingDelete(null);
    if (error) {
      toast.error(apiErrorMessage(error, 'Failed to delete the rank.'));
      return;
    }
    toast.success('Rank deleted');
    void invalidate();
  }

  const columns: DataTableColumn<JobRank>[] = [
    {
      key: 'ordinal',
      header: 'Order',
      cell: (r) => <span className="tabular-nums">{r.ordinal}</span>,
    },
    {
      key: 'name',
      header: 'Name',
      cell: (r) => <span className="font-medium text-fg">{r.name}</span>,
    },
    {
      key: 'wfh',
      header: 'WFH days per week',
      align: 'right',
      cell: (r) => {
        const days = wfhWeeklyDaysOf(r);
        return days === null ? (
          <span className="text-fg-subtle">None</span>
        ) : (
          <span className="tabular-nums">{days}</span>
        );
      },
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: (r) =>
        !canManage ? null : (
          <div className="flex items-center justify-end gap-1">
            <Tooltip content="Edit">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Edit ${r.name}`}
                onClick={() => setEditing(r)}
              >
                <Pencil className="h-4 w-4" strokeWidth={2} />
              </Button>
            </Tooltip>
            <Tooltip content="Delete">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Delete ${r.name}`}
                onClick={() => setPendingDelete(r)}
              >
                <Trash2 className="h-4 w-4" strokeWidth={2} />
              </Button>
            </Tooltip>
          </div>
        ),
    },
  ];

  return (
    <>
      {creating && <RankModal open onClose={() => setCreating(false)} onSuccess={invalidate} />}
      {editing && (
        <RankModal
          open
          rank={editing}
          onClose={() => setEditing(undefined)}
          onSuccess={invalidate}
        />
      )}
      <ConfirmDialog
        open={!!pendingDelete}
        onCancel={() => setPendingDelete(null)}
        onConfirm={deleteRank}
        loading={deleting}
        variant="danger"
        title="Delete this rank?"
        description="Only a rank that no role carries can be deleted. This cannot be undone."
        confirmLabel="Delete rank"
      />

      <ListPage
        title="Ranks"
        description="Seniority ranks, and the work-from-home days a week each one allows."
        actions={
          canManage ? (
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" strokeWidth={2} />
              New rank
            </Button>
          ) : undefined
        }
      >
        <DataTable
          columns={columns}
          rows={ranks.data}
          isLoading={ranks.isLoading}
          isError={ranks.isError}
          errorMessage="Failed to load ranks."
          emptyMessage="No ranks yet"
          emptyIcon={Layers}
          emptyAction={
            canManage ? (
              <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
                <Plus className="h-3.5 w-3.5" /> Create your first rank
              </Button>
            ) : undefined
          }
        />
      </ListPage>
    </>
  );
}
