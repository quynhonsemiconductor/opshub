import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Search, Trash2, UserCheck } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/shared/api/client';
import { apiErrorMessage } from '@/shared/api/errors';
import {
  Badge,
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
  Select,
  humanizeStatus,
  type DataTableColumn,
} from '@/shared/ui';
import { employeeOptions } from '@/shared/api/picker-sources';
import { formatDate } from '@/shared/lib/format';
import { usePermissions } from '@/shared/hooks/use-permissions';
import { SectionCard, SectionHeader } from './rbac-shared';
import { useRoles } from './use-rbac';
import type { RoleAssignmentResponse, RoleResponse } from '@/shared/api/types';

function AssignRoleModal({
  open,
  roles,
  onClose,
  onSuccess,
}: {
  open: boolean;
  roles: RoleResponse[];
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [userId, setUserId] = useState('');
  const [roleId, setRoleId] = useState('');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!userId.trim() || !roleId) {
      setErr('User ID and role are both required.');
      return;
    }
    setLoading(true);
    setErr('');
    const { error } = await api.POST('/v1/authz/assignments', {
      body: { userId: userId.trim(), roleId, scopeType: 'global', scopeId: null },
    });
    setLoading(false);
    if (error) {
      /*
       * NOT "check the user ID", which is what this said. The id came out of a picker, so it is the
       * one part of the submission nobody mistyped; the likeliest refusal is `role.assign`, which only
       * `admin` holds. The tab now hides Assign from a caller who lacks it, but the message still has
       * to pass the API's own sentence through: a stale token, a role deleted underneath the form, or
       * a scope the caller may not write all answer here, and each says something different.
       */
      setErr(apiErrorMessage(error, 'Failed to assign the role.'));
      return;
    }
    toast.success('Role assigned');
    onSuccess();
    onClose();
  }

  return (
    <Modal open={open} onClose={onClose} title="Assign role" size="sm">
      <form onSubmit={submit} className="flex flex-col gap-3 p-5">
        <FormField label="User" htmlFor="assign-user" required>
          <EntityPicker
            id="assign-user"
            queryKey="employees"
            value={userId}
            onChange={setUserId}
            fetchOptions={employeeOptions}
            placeholder="Search people…"
          />
        </FormField>
        <FormField
          label="Role"
          htmlFor="assign-role"
          required
          hint="Assigned GLOBALLY. Scoped assignments are made by the API, not from here."
        >
          <Select id="assign-role" value={roleId} onChange={(e) => setRoleId(e.target.value)}>
            <option value="">Select a role…</option>
            {roles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </Select>
        </FormField>
        <FormError message={err} />
        <FormActions
          loading={loading}
          onClose={onClose}
          submitLabel="Assign"
          pendingLabel="Assigning…"
        />
      </form>
    </Modal>
  );
}

/**
 * Who holds which role.
 *
 * LOOKUP BY USER, not a list of everything: the API exposes assignments per user
 * (`/authz/users/{userId}/assignments`) because a global list is unbounded. The empty state says so
 * rather than looking like a broken table, which is what a bare "no rows" implied before.
 */
export function AssignmentsTab() {
  const qc = useQueryClient();
  /*
   * `role.assign`, and DELIBERATELY NOT `rbac.manage`. `POST /authz/assignments` and
   * `DELETE /authz/assignments/:id` both carry `@RequirePermission('role.assign')` in
   * `libs/modules/authz/src/interface/http/authz.controller.ts`, while the Roles tab's routes carry
   * `rbac.manage`. They are two separable capabilities — editing what a role MEANS is not the same
   * authority as deciding who HOLDS it — so this tab asks for its own, and a holder of only the other
   * one sees no Assign and no Revoke here.
   *
   * The LOOKUP below stays ungated: `GET /authz/users/:userId/assignments` is `rbac.read`, which is
   * what it takes to reach this screen at all. An auditor is meant to read who holds what.
   */
  const canAssign = usePermissions().can('role.assign');
  const [lookupUserId, setLookupUserId] = useState('');
  const [searchUserId, setSearchUserId] = useState('');
  const [pendingRevokeId, setPendingRevokeId] = useState<string | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [showAssign, setShowAssign] = useState(false);

  const {
    data: assignments,
    isLoading,
    isError,
  } = useQuery<RoleAssignmentResponse[]>({
    queryKey: ['authz', 'assignments', searchUserId],
    enabled: searchUserId.length > 0,
    queryFn: async () => {
      const { data, error } = await api.GET('/v1/authz/users/{userId}/assignments', {
        params: { path: { userId: searchUserId } },
      });
      if (error || !data) throw new Error('Failed to load assignments');
      return data as RoleAssignmentResponse[];
    },
  });
  const { data: roles } = useRoles();

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ['authz', 'assignments', searchUserId] });

  const roleName = (roleId: string) => roles?.find((r) => r.id === roleId)?.name ?? roleId;

  async function doRevoke() {
    if (!pendingRevokeId) return;
    setRevoking(true);
    const { error } = await api.DELETE('/v1/authz/assignments/{id}', {
      params: { path: { id: pendingRevokeId } },
    });
    setRevoking(false);
    setPendingRevokeId(null);
    if (error) {
      toast.error(apiErrorMessage(error, 'Failed to revoke assignment.'));
      return;
    }
    toast.success('Assignment revoked');
    invalidate();
  }

  const columns: DataTableColumn<RoleAssignmentResponse>[] = [
    {
      key: 'userId',
      header: 'User ID',
      cell: (a) => <span className="font-mono text-xs text-fg-muted">{a.userId}</span>,
    },
    {
      key: 'role',
      header: 'Role',
      // The response carries `roleId`, not a name — so the name is looked up from the roles query
      // this tab already loads for the assign form. Falling back to the id keeps a row readable if
      // the role was deleted underneath the assignment.
      cell: (a) => <Badge tone="blue">{roleName(a.roleId)}</Badge>,
    },
    { key: 'scope', header: 'Scope', cell: (a) => humanizeStatus(a.scopeType) },
    { key: 'expires', header: 'Expires', cell: (a) => formatDate(a.expiresAt) },
    {
      key: 'actions',
      header: '',
      align: 'right',
      // Null rather than an absent column, so the table keeps its shape for a reader: the header is
      // already blank, and dropping the column would reflow every other one on the same data.
      cell: (a) =>
        !canAssign ? null : (
          <IconAction
            label="Revoke assignment"
            icon={Trash2}
            tone="danger"
            onClick={() => setPendingRevokeId(a.id)}
          />
        ),
    },
  ];

  return (
    <>
      <AssignRoleModal
        open={showAssign}
        roles={roles ?? []}
        onClose={() => setShowAssign(false)}
        onSuccess={invalidate}
      />

      <ConfirmDialog
        open={!!pendingRevokeId}
        onCancel={() => setPendingRevokeId(null)}
        onConfirm={doRevoke}
        loading={revoking}
        title="Revoke role assignment?"
        description="The user loses every permission this role grants, immediately."
        confirmLabel="Revoke"
        variant="danger"
      />

      <SectionCard>
        <SectionHeader
          title="Assignments"
          description="Look a user up by id to see and revoke what they hold."
          action={
            canAssign ? (
              <Button variant="primary" size="sm" onClick={() => setShowAssign(true)}>
                <UserCheck className="h-3.5 w-3.5" /> Assign role
              </Button>
            ) : undefined
          }
        />

        <form
          className="flex items-center gap-2 border-b border-border px-4 py-3"
          onSubmit={(e) => {
            e.preventDefault();
            setSearchUserId(lookupUserId.trim());
          }}
        >
          <Input
            value={lookupUserId}
            onChange={(e) => setLookupUserId(e.target.value)}
            aria-label="User ID to look up"
            placeholder="Enter a user ID to look up assignments…"
            className="max-w-md"
          />
          <Button type="submit" size="sm" variant="outline">
            <Search className="h-3.5 w-3.5" /> Look up
          </Button>
        </form>

        {/* Nothing is fetched until a user is named, so the pre-search state is its own message and
            not an empty table pretending the user has no roles. */}
        {searchUserId ? (
          <DataTable
            columns={columns}
            rows={assignments}
            isLoading={isLoading}
            isError={isError}
            errorMessage="Failed to load assignments for that user."
            emptyMessage="No assignments for this user"
            emptyIcon={UserCheck}
            emptyAction={
              !canAssign ? undefined : (
                <Button variant="primary" size="sm" onClick={() => setShowAssign(true)}>
                  <UserCheck className="h-3.5 w-3.5" /> Assign role
                </Button>
              )
            }
          />
        ) : (
          <p className="px-4 py-10 text-center text-sm text-fg-subtle">
            Enter a user ID above to view their assignments.
          </p>
        )}
      </SectionCard>
    </>
  );
}
