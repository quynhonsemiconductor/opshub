import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, Users } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/shared/api/client';
import { apiErrorMessage } from '@/shared/api/errors';
import {
  Button,
  ConfirmDialog,
  DataTable,
  EntityPicker,
  FormActions,
  FormError,
  FormField,
  IconAction,
  Input,
  Modal,
  StatusBadge,
  statusTone,
  type DataTableColumn,
} from '@/shared/ui';
import { activeEmployeeOptions } from '@/shared/api/picker-sources';
import { formatDateTime, orDash } from '@/shared/lib/format';
import { SectionCard, SectionHeader } from './rbac-shared';
import type { DelegationResponse } from '@/shared/api/types';

function CreateDelegationModal({
  open,
  onClose,
  onSuccess,
}: {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [toUserId, setToUserId] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!toUserId.trim() || !endsAt) {
      setErr('Delegate and end date are both required.');
      return;
    }
    setLoading(true);
    setErr('');
    const { error } = await api.POST('/v1/authz/delegations', {
      body: {
        toUserId: toUserId.trim(),
        startsAt: new Date().toISOString(),
        endsAt: new Date(endsAt).toISOString(),
        reason: reason.trim() || undefined,
      },
    });
    setLoading(false);
    if (error) {
      setErr(apiErrorMessage(error, 'Failed to create the delegation.'));
      return;
    }
    toast.success('Delegation created');
    onSuccess();
    onClose();
  }

  return (
    <Modal open={open} onClose={onClose} title="New delegation" size="sm">
      <form onSubmit={submit} className="flex flex-col gap-3 p-5">
        <FormField
          label="Delegate to"
          htmlFor="deleg-to"
          required
          hint="They will be able to approve requests in your name until it ends."
        >
          <EntityPicker
            id="deleg-to"
            queryKey="active-employees"
            value={toUserId}
            onChange={setToUserId}
            fetchOptions={activeEmployeeOptions}
            placeholder="Search people…"
          />
        </FormField>
        <FormField
          label="Ends at"
          htmlFor="deleg-ends"
          required
          hint="Starts immediately. A delegation with no end is a permanent transfer of authority."
        >
          <Input
            id="deleg-ends"
            type="datetime-local"
            value={endsAt}
            onChange={(e) => setEndsAt(e.target.value)}
          />
        </FormField>
        <FormField label="Reason" htmlFor="deleg-reason">
          <Input
            id="deleg-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Parental leave coverage"
          />
        </FormField>
        <FormError message={err} />
        <FormActions
          loading={loading}
          onClose={onClose}
          submitLabel="Create"
          pendingLabel="Creating…"
        />
      </form>
    </Modal>
  );
}

/**
 * Approval delegations — who may decide in whose place, and until when.
 *
 * ACTIVE IS DERIVED, not stored: a delegation is in force when now falls inside its window. Computed
 * per render rather than at mount, because a panel left open across a boundary would otherwise keep
 * claiming a lapsed delegation is live.
 *
 * DELIBERATELY UNGATED, and this is the one tab on the screen where that is correct. The other two
 * tabs' routes carry `@RequirePermission` — `rbac.manage` for roles, `role.assign` for assignments —
 * and the three delegation routes carry `@SelfScoped` instead: no permission, only a session. The
 * reason is in the decorator's own note on `POST /authz/delegations` — it "delegates the CALLER's own
 * approval authority — fromUserId is user.sub". The API takes the grantor from the token and IGNORES
 * anything the body might say, so there is no way to create a delegation FROM somebody else and
 * nothing here to gate; `DELETE` is keyed on `(id, user.sub)`, so only the grantor can revoke, and the
 * list defaults to `direction=from`, so every row shown IS the caller's own to revoke.
 *
 * Gating these on `rbac.manage` alongside the rest of the screen would therefore be a REGRESSION: it
 * would take out-of-office cover away from every `rbac.read` holder for a 403 the API would never
 * have raised. The spec asserts the New delegation button survives for a reader precisely so that a
 * later sweep for "ungated write controls on the RBAC screen" cannot quietly remove it.
 */
export function DelegationsTab() {
  const qc = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const {
    data: delegations,
    isLoading,
    isError,
  } = useQuery<DelegationResponse[]>({
    queryKey: ['authz', 'delegations'],
    queryFn: async () => {
      const { data, error } = await api.GET('/v1/authz/delegations');
      if (error || !data) throw new Error('Failed to load delegations');
      return data as DelegationResponse[];
    },
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['authz', 'delegations'] });

  async function doDelete() {
    if (!pendingDeleteId) return;
    setDeleting(true);
    const { error } = await api.DELETE('/v1/authz/delegations/{id}', {
      params: { path: { id: pendingDeleteId } },
    });
    setDeleting(false);
    setPendingDeleteId(null);
    if (error) {
      toast.error(apiErrorMessage(error, 'Failed to delete delegation.'));
      return;
    }
    toast.success('Delegation deleted');
    invalidate();
  }

  const columns: DataTableColumn<DelegationResponse>[] = [
    {
      key: 'from',
      header: 'From',
      cell: (d) => <span className="font-mono text-xs text-fg-muted">{d.fromUserId}</span>,
    },
    {
      key: 'to',
      header: 'To',
      cell: (d) => <span className="font-mono text-xs text-fg-muted">{d.toUserId}</span>,
    },
    {
      key: 'starts',
      header: 'Starts',
      cell: (d) => formatDateTime(d.startsAt),
      hideOnMobile: true,
    },
    { key: 'ends', header: 'Ends', cell: (d) => formatDateTime(d.endsAt) },
    {
      key: 'status',
      header: 'Status',
      cell: (d) => {
        const active = isActive(d);
        return (
          <StatusBadge tone={statusTone(active ? 'active' : 'expired')}>
            {active ? 'Active' : 'Inactive'}
          </StatusBadge>
        );
      },
    },
    {
      key: 'reason',
      header: 'Reason',
      cell: (d) => <span className="text-xs text-fg-muted">{orDash(d.reason)}</span>,
      className: 'max-w-[180px] truncate',
      hideOnMobile: true,
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: (d) => (
        <IconAction
          label="Delete delegation"
          icon={Trash2}
          tone="danger"
          onClick={() => setPendingDeleteId(d.id)}
        />
      ),
    },
  ];

  return (
    <>
      <CreateDelegationModal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        onSuccess={invalidate}
      />

      <ConfirmDialog
        open={!!pendingDeleteId}
        onCancel={() => setPendingDeleteId(null)}
        onConfirm={doDelete}
        loading={deleting}
        title="Delete delegation?"
        description="The delegate stops being able to approve in your name immediately. Only delegations you granted are listed here, so this is always your own."
        confirmLabel="Delete delegation"
        variant="danger"
      />

      <SectionCard>
        <SectionHeader
          title="Delegations"
          description="Approval authority you have handed to somebody else, and until when."
          action={
            <Button variant="primary" size="sm" onClick={() => setShowCreate(true)}>
              <Plus className="h-3.5 w-3.5" /> New delegation
            </Button>
          }
        />
        <DataTable
          columns={columns}
          rows={delegations}
          isLoading={isLoading}
          isError={isError}
          errorMessage="Failed to load delegations."
          emptyMessage="No delegations"
          emptyIcon={Users}
          emptyAction={
            <Button variant="primary" size="sm" onClick={() => setShowCreate(true)}>
              <Plus className="h-3.5 w-3.5" /> Create your first delegation
            </Button>
          }
        />
      </SectionCard>
    </>
  );
}

/** In force when now falls inside the window. */
function isActive(d: DelegationResponse): boolean {
  const now = Date.now();
  return new Date(d.startsAt).getTime() <= now && new Date(d.endsAt).getTime() >= now;
}
