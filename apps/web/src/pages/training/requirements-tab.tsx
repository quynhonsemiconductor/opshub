import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ClipboardList, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/shared/api/client';
import { apiErrorMessage } from '@/shared/api/errors';
import { courseOptions, roleOptions } from '@/shared/api/picker-sources';
import {
  Badge,
  Button,
  ConfirmDialog,
  DataTable,
  EntityPicker,
  FormActions,
  FormError,
  FormField,
  Input,
  Modal,
  RowActions,
  Select,
  TabToolbar,
  Tooltip,
  humanizeStatus,
  type DataTableColumn,
} from '@/shared/ui';
import { usePermissions } from '@/shared/hooks/use-permissions';
import { orDash } from '@/shared/lib/format';
import { REQUIREMENT_KINDS } from './training.types';
import { useRequirements } from './use-training';
import type { Requirement } from './training.types';

/**
 * Which courses a ROLE requires — the rule the gap report is computed from.
 *
 * KEYED ON THE ROLE, NOT THE PERSON. That is the whole design: requirements attach to the job, so
 * moving somebody into a role gives them its training obligations automatically and nobody maintains a
 * per-employee checklist. It is also why this tab starts empty and asks which role, rather than
 * showing a list of requirements with no context.
 *
 * GRACE DAYS are how long after a lapse the requirement still counts as met — a week to re-sit a course
 * without the person showing up as non-compliant on the day it expired.
 *
 * WRITING THE RULE NEEDS `training.manage`; READING IT NEEDS `training.read`. `POST
 * /training/roles/{roleId}/requirements` and `DELETE /training/requirements/{id}` both carry
 * `@RequirePermission('training.manage')`, while `GET /training/roles/{roleId}/requirements`
 * asks only for `training.read`. That asymmetry is the point of the tab for a read-only holder: a
 * manager or an auditor comes here to see what a job demands, not to change what it demands — and a
 * requirement is the input to the gap report, so an auditor able to delete one could delete the finding
 * along with it.
 */
function AddRequirementModal({
  roleId,
  roleTitle,
  onClose,
  onSuccess,
}: {
  roleId: string;
  roleTitle: string;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [courseId, setCourseId] = useState('');
  const [kind, setKind] = useState<(typeof REQUIREMENT_KINDS)[number]>('mandatory');
  const [graceDays, setGraceDays] = useState('');
  const [error, setError] = useState('');

  const mutation = useMutation({
    mutationFn: async () => {
      const { error: err } = await api.POST('/v1/training/roles/{roleId}/requirements', {
        params: { path: { roleId } },
        body: { courseId, kind, graceDays: graceDays ? Number(graceDays) : null },
      });
      if (err) throw new Error(apiErrorMessage(err, 'Failed to add the requirement.'));
    },
    onSuccess: () => {
      toast.success('Requirement added');
      onSuccess();
      onClose();
    },
    onError: (e: Error) => setError(e.message),
  });

  return (
    <Modal open onClose={onClose} size="sm" title={`Require a course for ${roleTitle}`}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setError('');
          mutation.mutate();
        }}
        className="flex flex-col gap-4 p-5"
      >
        <FormField label="Course" htmlFor="req-course" required>
          <EntityPicker
            id="req-course"
            queryKey="courses"
            value={courseId}
            onChange={setCourseId}
            fetchOptions={courseOptions}
            placeholder="Search courses…"
          />
        </FormField>

        <FormField
          label="Kind"
          htmlFor="req-kind"
          required
          hint="A missing mandatory course is a finding; a missing recommended one is a suggestion, and the gap report leaves it out unless asked."
        >
          <Select
            id="req-kind"
            value={kind}
            onChange={(e) => setKind(e.target.value as typeof kind)}
          >
            {REQUIREMENT_KINDS.map((option) => (
              <option key={option} value={option}>
                {humanizeStatus(option)}
              </option>
            ))}
          </Select>
        </FormField>

        <FormField
          label="Grace days"
          htmlFor="req-grace"
          hint="How long after expiry the requirement still counts as met. Empty means none."
        >
          <Input
            id="req-grace"
            type="number"
            min={0}
            value={graceDays}
            onChange={(e) => setGraceDays(e.target.value)}
            placeholder="0"
          />
        </FormField>

        <FormError message={error} />

        <FormActions loading={mutation.isPending} onClose={onClose} submitLabel="Add requirement" />
      </form>
    </Modal>
  );
}

export function RequirementsTab() {
  const qc = useQueryClient();
  const { can } = usePermissions();
  const canManage = can('training.manage');
  const [roleId, setRoleId] = useState('');
  const [roleTitle, setRoleTitle] = useState('');
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Requirement | null>(null);

  const requirements = useRequirements(roleId || null);
  const invalidate = () => qc.invalidateQueries({ queryKey: ['training'] });

  async function remove() {
    if (!removing) return;
    const { error } = await api.DELETE('/v1/training/requirements/{id}', {
      params: { path: { id: removing.id } },
    });
    setRemoving(null);
    if (error) {
      toast.error(apiErrorMessage(error, 'Failed to remove the requirement.'));
      return;
    }
    toast.success('Requirement removed');
    invalidate();
  }

  const columns: DataTableColumn<Requirement>[] = [
    {
      key: 'code',
      header: 'Code',
      cell: (requirement) => (
        <span className="font-mono text-xs font-medium text-fg">{requirement.courseCode}</span>
      ),
    },
    { key: 'title', header: 'Course', cell: (requirement) => requirement.courseTitle },
    {
      key: 'kind',
      header: 'Kind',
      cell: (requirement) => (
        <Badge tone={requirement.kind === 'mandatory' ? 'red' : 'blue'}>
          {humanizeStatus(requirement.kind)}
        </Badge>
      ),
    },
    {
      key: 'grace',
      header: 'Grace',
      align: 'right',
      cell: (requirement) =>
        requirement.graceDays == null ? (
          orDash(null)
        ) : (
          <span className="tabular-nums">{requirement.graceDays} days</span>
        ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: (requirement) =>
        canManage ? (
          <RowActions>
            <Tooltip content="Remove">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove ${requirement.courseTitle}`}
                onClick={() => setRemoving(requirement)}
              >
                <Trash2 className="h-3.5 w-3.5" strokeWidth={2} />
              </Button>
            </Tooltip>
          </RowActions>
        ) : null,
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      {adding && roleId && (
        <AddRequirementModal
          roleId={roleId}
          roleTitle={roleTitle || 'this role'}
          onClose={() => setAdding(false)}
          onSuccess={invalidate}
        />
      )}

      <ConfirmDialog
        open={!!removing}
        onCancel={() => setRemoving(null)}
        onConfirm={remove}
        title="Remove this requirement?"
        description="Nobody in this role will be expected to hold the course any more, and it disappears from their gap report. Existing records are untouched."
        confirmLabel="Remove requirement"
        variant="danger"
      />

      <TabToolbar
        filter={
          <div className="w-72">
            <EntityPicker
              ariaLabel="Role"
              queryKey="roles"
              value={roleId}
              onChange={(value, option) => {
                setRoleId(value);
                // The picker is the only thing that knows the title, so the modal can name the role
                // instead of repeating its id.
                setRoleTitle(option?.label ?? '');
              }}
              selectedLabel={roleTitle || undefined}
              fetchOptions={roleOptions}
              placeholder="Choose a role…"
            />
          </div>
        }
        action={
          // TWO DIFFERENT REASONS TO WITHHOLD THIS, and they are not interchangeable. `disabled` means
          // "not yet — name a role first", which is actionable and resolves in one click, so the
          // button stays on screen saying so. No `training.manage` means "not you, ever, on this
          // screen", which no amount of clicking resolves, so the button is absent instead of greyed.
          canManage ? (
            <Button variant="primary" size="sm" disabled={!roleId} onClick={() => setAdding(true)}>
              <Plus className="h-3.5 w-3.5" strokeWidth={2} />
              Require a course
            </Button>
          ) : undefined
        }
      />

      {/* Nothing chosen is not an empty result — saying "no requirements" here would be a claim about a
          role nobody named. */}
      {!roleId ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border py-12 text-center">
          <ClipboardList className="h-6 w-6 text-fg-subtle" strokeWidth={1.5} />
          <p className="text-sm text-fg-muted">Choose a role to see what it requires.</p>
        </div>
      ) : (
        <DataTable
          columns={columns}
          rows={requirements.data}
          isLoading={requirements.isLoading}
          isError={requirements.isError}
          errorMessage="Failed to load requirements."
          emptyMessage="This role requires no training yet"
          emptyIcon={ClipboardList}
          emptyAction={
            !canManage ? undefined : (
              <Button variant="primary" size="sm" onClick={() => setAdding(true)}>
                <Plus className="h-3.5 w-3.5" /> Add your first requirement
              </Button>
            )
          }
        />
      )}
    </div>
  );
}
