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
import { useGroups } from './use-rbac';
import type { EmployeeGroupResponse, GroupResponse } from '@/shared/api/types';

function AddToGroupModal({
  open,
  groups,
  onClose,
  onSuccess,
}: {
  open: boolean;
  groups: GroupResponse[];
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [employeeId, setEmployeeId] = useState('');
  const [groupId, setGroupId] = useState('');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!employeeId.trim() || !groupId) {
      setErr('An employee and a group are both required.');
      return;
    }
    setLoading(true);
    setErr('');
    const { error } = await api.POST('/v1/authz/employee-groups', {
      body: { employeeId: employeeId.trim(), groupId, scopeType: 'global', scopeId: null },
    });
    setLoading(false);
    if (error) {
      /*
       * NOT "check the user ID", which is what this said. The id came out of a picker, so it is the
       * one part of the submission nobody mistyped; the likeliest refusal is `group.assign`, which only
       * `admin` holds. The tab now hides Assign from a caller who lacks it, but the message still has
       * to pass the API's own sentence through: a stale token, a group deleted underneath the form, or
       * a scope the caller may not write all answer here, and each says something different.
       */
      setErr(apiErrorMessage(error, 'Failed to add the employee to the group.'));
      return;
    }
    toast.success('Added to group');
    onSuccess();
    onClose();
  }

  return (
    <Modal open={open} onClose={onClose} title="Add to group" size="sm">
      <form onSubmit={submit} className="flex flex-col gap-3 p-5">
        <FormField label="Employee" htmlFor="assign-employee" required>
          <EntityPicker
            id="assign-employee"
            queryKey="employees"
            value={employeeId}
            onChange={setEmployeeId}
            fetchOptions={employeeOptions}
            placeholder="Search people…"
          />
        </FormField>
        <FormField
          label="Group"
          htmlFor="assign-group"
          required
          hint="Added GLOBALLY. Scoped memberships are made by the API, not from here."
        >
          <Select id="assign-group" value={groupId} onChange={(e) => setGroupId(e.target.value)}>
            <option value="">Select a group…</option>
            {groups.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </Select>
        </FormField>
        <FormError message={err} />
        <FormActions loading={loading} onClose={onClose} submitLabel="Add" pendingLabel="Adding…" />
      </form>
    </Modal>
  );
}

/**
 * Who holds which group.
 *
 * LOOKUP BY EMPLOYEE, not a list of everything: the API exposes memberships per employee
 * (`/authz/employees/{employeeId}/groups`) because a global list is unbounded. The empty state says so
 * rather than looking like a broken table, which is what a bare "no rows" implied before.
 */
export function EmployeeGroupsTab() {
  const qc = useQueryClient();
  /*
   * `group.assign`, and DELIBERATELY NOT `rbac.manage`. `POST /authz/employee-groups` and
   * `DELETE /authz/employee-groups/:id` both carry `@RequirePermission('group.assign')` in
   * `libs/modules/authz/src/interface/http/authz.controller.ts`, while the Groups tab's routes carry
   * `rbac.manage`. They are two separable capabilities — editing what a group MEANS is not the same
   * authority as deciding who HOLDS it — so this tab asks for its own, and a holder of only the other
   * one sees no Add and no Remove here.
   *
   * The LOOKUP below stays ungated: `GET /authz/employees/:employeeId/groups` is `rbac.read`, which is
   * what it takes to reach this screen at all. An auditor is meant to read who holds what.
   */
  const canAssign = usePermissions().can('group.assign');
  const [lookupUserId, setLookupUserId] = useState('');
  const [searchUserId, setSearchUserId] = useState('');
  const [pendingRevokeId, setPendingRevokeId] = useState<string | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [showAssign, setShowAssign] = useState(false);

  const {
    data: assignments,
    isLoading,
    isError,
  } = useQuery<EmployeeGroupResponse[]>({
    queryKey: ['authz', 'memberships', searchUserId],
    enabled: searchUserId.length > 0,
    queryFn: async () => {
      const { data, error } = await api.GET('/v1/authz/employees/{employeeId}/groups', {
        params: { path: { employeeId: searchUserId } },
      });
      if (error || !data) throw new Error('Failed to load memberships');
      return data as EmployeeGroupResponse[];
    },
  });
  const { data: groups } = useGroups();

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ['authz', 'memberships', searchUserId] });

  const roleName = (groupId: string) => groups?.find((r) => r.id === groupId)?.name ?? groupId;

  async function doRevoke() {
    if (!pendingRevokeId) return;
    setRevoking(true);
    const { error } = await api.DELETE('/v1/authz/employee-groups/{id}', {
      params: { path: { id: pendingRevokeId } },
    });
    setRevoking(false);
    setPendingRevokeId(null);
    if (error) {
      toast.error(apiErrorMessage(error, 'Failed to remove the employee from the group.'));
      return;
    }
    toast.success('Removed from group');
    invalidate();
  }

  const columns: DataTableColumn<EmployeeGroupResponse>[] = [
    {
      key: 'employeeId',
      header: 'Employee ID',
      cell: (a) => <span className="font-mono text-xs text-fg-muted">{a.employeeId}</span>,
    },
    {
      key: 'group',
      header: 'Group',
      // The response carries `groupId`, not a name — so the name is looked up from the groups query
      // this tab already loads for the assign form. Falling back to the id keeps a row readable if
      // the group was deleted underneath the assignment.
      cell: (a) => <Badge tone="blue">{roleName(a.groupId)}</Badge>,
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
            label="Remove from group"
            icon={Trash2}
            tone="danger"
            onClick={() => setPendingRevokeId(a.id)}
          />
        ),
    },
  ];

  return (
    <>
      <AddToGroupModal
        open={showAssign}
        groups={groups ?? []}
        onClose={() => setShowAssign(false)}
        onSuccess={invalidate}
      />

      <ConfirmDialog
        open={!!pendingRevokeId}
        onCancel={() => setPendingRevokeId(null)}
        onConfirm={doRevoke}
        loading={revoking}
        title="Remove from group?"
        description="The employee loses every permission this group grants, immediately."
        confirmLabel="Remove"
        variant="danger"
      />

      <SectionCard>
        <SectionHeader
          title="Memberships"
          description="Look an employee up by id to see and remove the groups they belong to."
          action={
            canAssign ? (
              <Button variant="primary" size="sm" onClick={() => setShowAssign(true)}>
                <UserCheck className="h-3.5 w-3.5" /> Add to group
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
            aria-label="Employee ID to look up"
            placeholder="Enter an employee ID to look up their groups…"
            className="max-w-md"
          />
          <Button type="submit" size="sm" variant="outline">
            <Search className="h-3.5 w-3.5" /> Look up
          </Button>
        </form>

        {/* Nothing is fetched until a user is named, so the pre-search state is its own message and
            not an empty table pretending the user has no groups. */}
        {searchUserId ? (
          <DataTable
            columns={columns}
            rows={assignments}
            isLoading={isLoading}
            isError={isError}
            errorMessage="Failed to load the groups of that employee."
            emptyMessage="This employee belongs to no group"
            emptyIcon={UserCheck}
            emptyAction={
              !canAssign ? undefined : (
                <Button variant="primary" size="sm" onClick={() => setShowAssign(true)}>
                  <UserCheck className="h-3.5 w-3.5" /> Add to a group
                </Button>
              )
            }
          />
        ) : (
          <p className="px-4 py-10 text-center text-sm text-fg-subtle">
            Enter an employee ID above to view their groups.
          </p>
        )}
      </SectionCard>
    </>
  );
}
