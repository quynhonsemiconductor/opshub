import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Plus, ShieldCheck, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/shared/api/client';
import { apiErrorMessage } from '@/shared/api/errors';
import {
  Badge,
  Button,
  ConfirmDialog,
  DataTable,
  EntityDetailPanel,
  FOCUS_RING,
  FormActions,
  FormError,
  FormField,
  IconAction,
  Input,
  Modal,
  Select,
  type DataTableColumn,
} from '@/shared/ui';
import { cn } from '@/shared/lib/utils';
import { usePermissions } from '@/shared/hooks/use-permissions';
import { SectionCard, SectionHeader } from './rbac-shared';
import { usePermissionCatalogue, useGroups } from './use-rbac';
import type { GroupResponse } from '@/shared/api/types';

function CreateRoleModal({
  open,
  onClose,
  onSuccess,
}: {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!key.trim() || !name.trim()) {
      setErr('Key and name are required.');
      return;
    }
    setLoading(true);
    setErr('');
    const { error } = await api.POST('/v1/authz/groups', {
      body: { key: key.trim(), name: name.trim(), permissions: [] },
    });
    setLoading(false);
    if (error) {
      // The API says WHICH key collided, and whether a collision was the problem at all — this file
      // already reads its message on the delete path two functions below.
      setErr(apiErrorMessage(error, 'Failed to create the group.'));
      return;
    }
    toast.success('Group created');
    onSuccess();
    onClose();
  }

  return (
    <Modal open={open} onClose={onClose} title="Create group" size="sm">
      <form onSubmit={submit} className="flex flex-col gap-3 p-5">
        <FormField
          label="Key"
          htmlFor="group-key"
          required
          hint="The slug the API and the guards match on. Cannot be changed later."
        >
          <Input
            id="group-key"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="e.g. compliance-reviewer"
          />
        </FormField>
        <FormField label="Display name" htmlFor="group-name" required>
          <Input
            id="group-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Compliance Reviewer"
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
 * Groups, their permissions, and which of them the system owns.
 *
 * A TABLE, not a hand-rolled card list. The rows were `<div>`s with a click handler: no header, no
 * empty state, no loading state, and nothing to tell a keyboard user they were interactive. The
 * column set is the same information the divs carried.
 */
export function GroupsTab() {
  const qc = useQueryClient();
  const { data: groups, isLoading, isError } = useGroups();
  const { data: allPerms } = usePermissionCatalogue();
  /*
   * `rbac.manage`, READ OFF THE CONTROLLER rather than inferred from the screen's name. All three
   * routes behind this tab carry `@RequirePermission('rbac.manage')` in
   * `libs/modules/authz/src/interface/http/authz.controller.ts`: `POST /authz/groups`,
   * `PUT /authz/groups/:id/permissions` and `DELETE /authz/groups/:id`. Reading the tab needs only
   * `rbac.read` — which `it-admin` and `auditor` hold and `rbac.manage` does not follow from — so
   * without this every control below was offered to two groups the API refuses.
   *
   * NOT the same permission as the Assignments tab, which is `group.assign`. Gating both on one flag
   * would hand group EDITING to whoever may only hand groups OUT, and the API would refuse it.
   */
  const canManage = usePermissions().can('rbac.manage');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [addPermKey, setAddPermKey] = useState('');
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const invalidate = () => qc.invalidateQueries({ queryKey: ['authz', 'groups'] });

  // Re-read from the list rather than holding the row: adding a permission has to be visible in the
  // open panel, and a captured copy would show the state from before the mutation.
  const current = groups?.find((r) => r.id === selectedId) ?? null;

  async function doDeleteRole() {
    if (!pendingDeleteId) return;
    setDeleting(true);
    const { error } = await api.DELETE('/v1/authz/groups/{id}', {
      params: { path: { id: pendingDeleteId } },
    });
    setDeleting(false);
    setPendingDeleteId(null);
    if (error) {
      toast.error(apiErrorMessage(error, 'Failed to delete group.'));
      return;
    }
    toast.success('Group deleted');
    if (selectedId === pendingDeleteId) setSelectedId(null);
    invalidate();
  }

  async function setPermissions(groupId: string, permissions: string[]) {
    const { error } = await api.PUT('/v1/authz/groups/{id}/permissions', {
      params: { path: { id: groupId } },
      body: { permissions },
    });
    if (error) {
      toast.error(apiErrorMessage(error, 'Failed to update permissions.'));
      return;
    }
    invalidate();
  }

  const columns: DataTableColumn<GroupResponse>[] = [
    {
      key: 'name',
      header: 'Group',
      cell: (group) => (
        <div className="flex items-center gap-3">
          <ShieldCheck className="h-4 w-4 shrink-0 text-fg-subtle" strokeWidth={1.75} />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-fg">{group.name}</p>
            <p className="truncate font-mono text-xs text-fg-subtle">{group.key}</p>
          </div>
        </div>
      ),
    },
    {
      key: 'type',
      header: 'Type',
      cell: (group) =>
        group.system ? <Badge>System</Badge> : <span className="text-fg">Custom</span>,
    },
    {
      key: 'permissions',
      header: 'Permissions',
      align: 'right',
      cell: (group) => group.permissions.length,
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: (group) => (
        <div onClick={(e) => e.stopPropagation()}>
          {/* A system group has no delete: the seed owns it, and removing it would break the guards.
              A reader without `rbac.manage` has none either — the row is theirs to inspect, not to
              destroy, and `DELETE /authz/groups/:id` would answer 403. */}
          {canManage && !group.system && (
            <IconAction
              label={`Delete ${group.name}`}
              icon={Trash2}
              tone="danger"
              onClick={() => setPendingDeleteId(group.id)}
            />
          )}
        </div>
      ),
    },
  ];

  return (
    <>
      <CreateRoleModal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        onSuccess={invalidate}
      />

      <ConfirmDialog
        open={!!pendingDeleteId}
        onCancel={() => setPendingDeleteId(null)}
        onConfirm={doDeleteRole}
        loading={deleting}
        title="Delete group?"
        description="This will permanently remove the group and all its permissions. Users with this group will lose access. This cannot be undone."
        confirmLabel="Delete group"
        variant="danger"
      />

      <SectionCard>
        <SectionHeader
          title="Groups"
          description="System groups come from the seed; custom groups are yours to manage."
          action={
            canManage ? (
              <Button variant="primary" size="sm" onClick={() => setShowCreate(true)}>
                <Plus className="h-3.5 w-3.5" /> New group
              </Button>
            ) : undefined
          }
        />
        <DataTable
          columns={columns}
          rows={groups}
          isLoading={isLoading}
          isError={isError}
          errorMessage="Failed to load groups."
          emptyMessage="No groups yet"
          emptyIcon={ShieldCheck}
          emptyAction={
            !canManage ? undefined : (
              <Button variant="primary" size="sm" onClick={() => setShowCreate(true)}>
                <Plus className="h-3.5 w-3.5" /> Create your first group
              </Button>
            )
          }
          onRowClick={(group) => {
            setSelectedId(group.id);
            setAddPermKey('');
          }}
          isRowActive={(group) => group.id === selectedId}
        />
      </SectionCard>

      <EntityDetailPanel
        open={!!current}
        onClose={() => {
          setSelectedId(null);
          setAddPermKey('');
        }}
        title={current?.name ?? 'Group'}
        description={current?.key}
        items={
          current
            ? [
                { label: 'Key', value: <span className="font-mono text-sm">{current.key}</span> },
                { label: 'Type', value: current.system ? <Badge>System</Badge> : 'Custom' },
                {
                  label: `Permissions (${current.permissions.length})`,
                  wide: true,
                  value: (
                    <div className="flex flex-col gap-3">
                      <div className="flex flex-wrap gap-1.5">
                        {current.permissions.length === 0 && (
                          <p className="text-xs text-fg-subtle">No permissions assigned</p>
                        )}
                        {current.permissions.map((p) => (
                          <span
                            key={p}
                            className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-0.5 font-mono text-xs text-fg-muted"
                          >
                            {p}
                            {/* The chip is read-only for a reader: revoking a permission is the same
                                `PUT …/permissions` as granting one, so an X here without
                                `rbac.manage` is a 403 dressed as an affordance. */}
                            {canManage && !current.system && (
                              <button
                                type="button"
                                aria-label={`Remove ${p}`}
                                onClick={() =>
                                  setPermissions(
                                    current.id,
                                    current.permissions.filter((x) => x !== p),
                                  )
                                }
                                className={cn(
                                  'rounded text-fg-subtle transition-colors hover:text-danger',
                                  FOCUS_RING,
                                )}
                              >
                                <X className="h-3 w-3" />
                              </button>
                            )}
                          </span>
                        ))}
                      </div>

                      {/* A system group's permissions are fixed by the seed, so no add control at all —
                          and neither is there one for a caller who cannot write the set. */}
                      {canManage && !current.system && allPerms && (
                        <div className="flex items-center gap-2">
                          <Select
                            aria-label="Permission to add"
                            className="h-7 py-0 text-xs"
                            value={addPermKey}
                            onChange={(e) => setAddPermKey(e.target.value)}
                          >
                            <option value="">Add permission…</option>
                            {allPerms
                              .filter((p) => !current.permissions.includes(p.key))
                              .map((p) => (
                                <option key={p.key} value={p.key}>
                                  {p.key}
                                </option>
                              ))}
                          </Select>
                          <Button
                            size="sm"
                            disabled={!addPermKey}
                            onClick={() => {
                              setPermissions(current.id, [...current.permissions, addPermKey]);
                              setAddPermKey('');
                            }}
                          >
                            Add
                          </Button>
                        </div>
                      )}
                    </div>
                  ),
                },
              ]
            : []
        }
        activity={current ? { resourceId: current.id, resourceType: 'group' } : undefined}
      />
    </>
  );
}
