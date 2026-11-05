import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Trash2 } from 'lucide-react';
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
  Textarea,
  humanizeStatus,
  type DataTableColumn,
} from '@/shared/ui';
import { employeeOptions } from '@/shared/api/picker-sources';
import { formatDate, todayIso } from '@/shared/lib/format';
import { usePermissions } from '@/shared/hooks/use-permissions';
import type { EmployeePermissionResponse } from '@/shared/api/types';
import { SectionCard, SectionHeader } from './rbac-shared';
import { usePermissionCatalogue } from './use-rbac';
import { DIRECT_PERMISSION_REASON_MAX_LENGTH } from './direct-permission.constants';
import {
  expiryInstantFromDate,
  isGrantExpired,
  validateGrantForm,
} from './direct-permission.helpers';

/**
 * Grants one permission straight to an employee, outside any group.
 *
 * Args:
 *   open: Whether the dialog is shown.
 *   employeeId: The employee chosen on the tab, to start from; the dialog still lets it be changed.
 *   onClose: Called when the dialog should close.
 *   onSuccess: Called after the grant was stored, so the tab can reload its list.
 */
function GrantPermissionModal({
  open,
  employeeId: initialEmployeeId,
  onClose,
  onSuccess,
}: {
  open: boolean;
  employeeId: string;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const { data: catalogue } = usePermissionCatalogue();
  const [employeeId, setEmployeeId] = useState(initialEmployeeId);
  const [permissionKey, setPermissionKey] = useState('');
  const [reason, setReason] = useState('');
  const [expiresOn, setExpiresOn] = useState('');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const problem = validateGrantForm({ employeeId, permissionKey, reason });
    if (problem) {
      setErr(problem);
      return;
    }
    setLoading(true);
    setErr('');
    const { error } = await api.POST('/v1/authz/employee-permissions', {
      body: {
        employeeId,
        permissionKey,
        scopeType: 'global',
        scopeId: null,
        reason: reason.trim(),
        expiresAt: expiryInstantFromDate(expiresOn),
      },
    });
    setLoading(false);
    if (error) {
      // The API's own sentence: the likeliest refusal is "you do not hold that permission without a scope
      // limit", which no client-side rule could predict.
      setErr(apiErrorMessage(error, 'Failed to grant the permission.'));
      return;
    }
    toast.success('Permission granted');
    onSuccess();
    onClose();
  }

  return (
    <Modal open={open} onClose={onClose} title="Grant a permission" size="sm">
      <form onSubmit={submit} className="flex flex-col gap-3 p-5">
        <FormField label="Employee" htmlFor="grant-employee" required>
          <EntityPicker
            id="grant-employee"
            queryKey="employees"
            value={employeeId}
            onChange={setEmployeeId}
            fetchOptions={employeeOptions}
            placeholder="Search people…"
          />
        </FormField>
        <FormField label="Permission" htmlFor="grant-permission" required>
          <Select
            id="grant-permission"
            value={permissionKey}
            onChange={(e) => setPermissionKey(e.target.value)}
          >
            <option value="">Select a permission…</option>
            {(catalogue ?? []).map((permission) => (
              <option key={permission.key} value={permission.key}>
                {permission.key}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField
          label="Reason"
          htmlFor="grant-reason"
          required
          hint="Shown in the audit log: a grant outside a group has to say why it exists."
        >
          <Textarea
            id="grant-reason"
            rows={2}
            maxLength={DIRECT_PERMISSION_REASON_MAX_LENGTH}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </FormField>
        <FormField
          label="Expires on"
          htmlFor="grant-expires"
          hint="Optional. The permission lasts through the end of that day. Granted GLOBALLY."
        >
          <Input
            id="grant-expires"
            type="date"
            min={todayIso()}
            value={expiresOn}
            onChange={(e) => setExpiresOn(e.target.value)}
          />
        </FormField>
        <FormError message={err} />
        <FormActions
          loading={loading}
          onClose={onClose}
          submitLabel="Grant"
          pendingLabel="Granting…"
        />
      </form>
    </Modal>
  );
}

/**
 * The permissions granted straight to one employee, outside any group.
 *
 * Groups are how almost everyone gets their permissions; this tab is the exception path, so every grant
 * here carries the reason it exists. LOOKUP BY EMPLOYEE, like the Memberships tab: the API lists direct
 * grants per employee because a global list is unbounded.
 *
 * Granting and revoking need `group.assign` (the same permission as putting an employee in a group, read
 * off the controller), while the lookup needs only `rbac.read`, so an auditor can see who holds what
 * without being offered a control that answers 403.
 */
export function DirectPermissionsTab() {
  const qc = useQueryClient();
  const canGrant = usePermissions().can('group.assign');
  const [employeeId, setEmployeeId] = useState('');
  const [showGrant, setShowGrant] = useState(false);
  const [pendingRevokeId, setPendingRevokeId] = useState<string | null>(null);
  const [revoking, setRevoking] = useState(false);

  const {
    data: grants,
    isLoading,
    isError,
  } = useQuery<EmployeePermissionResponse[]>({
    queryKey: ['authz', 'direct-permissions', employeeId],
    enabled: employeeId.length > 0,
    queryFn: async () => {
      const { data, error } = await api.GET('/v1/authz/employees/{employeeId}/permissions', {
        params: { path: { employeeId } },
      });
      if (error || !data) throw new Error('Failed to load direct permissions');
      return data as EmployeePermissionResponse[];
    },
  });

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ['authz', 'direct-permissions', employeeId] });

  async function doRevoke() {
    if (!pendingRevokeId) return;
    setRevoking(true);
    const { error } = await api.DELETE('/v1/authz/employee-permissions/{id}', {
      params: { path: { id: pendingRevokeId } },
    });
    setRevoking(false);
    setPendingRevokeId(null);
    if (error) {
      toast.error(apiErrorMessage(error, 'Failed to revoke the permission.'));
      return;
    }
    toast.success('Permission revoked');
    invalidate();
  }

  const now = new Date();
  const columns: DataTableColumn<EmployeePermissionResponse>[] = [
    {
      key: 'permission',
      header: 'Permission',
      cell: (g) => <span className="font-mono text-xs text-fg">{g.permissionKey}</span>,
    },
    { key: 'scope', header: 'Scope', cell: (g) => humanizeStatus(g.scopeType) },
    {
      key: 'reason',
      header: 'Reason',
      cell: (g) => <span className="line-clamp-2 text-xs text-fg-muted">{g.reason}</span>,
    },
    {
      key: 'expires',
      header: 'Expires',
      cell: (g) =>
        isGrantExpired(g.expiresAt, now) ? (
          <Badge tone="red">Expired {formatDate(g.expiresAt)}</Badge>
        ) : (
          formatDate(g.expiresAt)
        ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: (g) =>
        !canGrant ? null : (
          <IconAction
            label="Revoke permission"
            icon={Trash2}
            tone="danger"
            onClick={() => setPendingRevokeId(g.id)}
          />
        ),
    },
  ];

  return (
    <>
      <GrantPermissionModal
        key={showGrant ? employeeId : 'closed'}
        open={showGrant}
        employeeId={employeeId}
        onClose={() => setShowGrant(false)}
        onSuccess={invalidate}
      />

      <ConfirmDialog
        open={!!pendingRevokeId}
        onCancel={() => setPendingRevokeId(null)}
        onConfirm={doRevoke}
        loading={revoking}
        title="Revoke this permission?"
        description="The employee loses it immediately, unless one of their groups also grants it."
        confirmLabel="Revoke"
        variant="danger"
      />

      <SectionCard>
        <SectionHeader
          title="Direct permissions"
          description="Permissions granted to one employee outside any group. Pick an employee to see theirs."
          action={
            canGrant ? (
              <Button variant="primary" size="sm" onClick={() => setShowGrant(true)}>
                <KeyRound className="h-3.5 w-3.5" /> Grant a permission
              </Button>
            ) : undefined
          }
        />

        <div className="max-w-md border-b border-border px-4 py-3">
          <EntityPicker
            id="direct-permissions-employee"
            queryKey="employees"
            value={employeeId}
            onChange={setEmployeeId}
            fetchOptions={employeeOptions}
            placeholder="Search for an employee…"
          />
        </div>

        {/* Nothing is fetched until an employee is chosen, so the pre-search state is its own message and
            not an empty table pretending the employee has no direct permissions. */}
        {employeeId ? (
          <DataTable
            columns={columns}
            rows={grants}
            isLoading={isLoading}
            isError={isError}
            errorMessage="Failed to load the direct permissions of that employee."
            emptyMessage="This employee holds no permission outside their groups"
            emptyIcon={KeyRound}
          />
        ) : (
          <p className="px-4 py-10 text-center text-sm text-fg-subtle">
            Choose an employee above to see the permissions granted to them directly.
          </p>
        )}
      </SectionCard>
    </>
  );
}
