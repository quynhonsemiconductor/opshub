import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/shared/api/client';
import { apiErrorMessage } from '@/shared/api/errors';
import {
  EntityPicker,
  FormActions,
  FormError,
  FormField,
  Input,
  Modal,
  Select,
  Textarea,
} from '@/shared/ui';
import { activeEmployeeOptions } from '@/shared/api/picker-sources';
import { todayIso } from '@/shared/lib/format';
import type { Position } from './position.types';
import { useJobRanks } from './use-job-ranks';

/**
 * Create or edit a position.
 *
 * A position's CODE is immutable after creation — it is quoted in contracts, training requirements and
 * org charts, so the edit form omits it rather than offering a field the API would reject.
 */
export function PositionModal({
  open,
  position,
  onClose,
  onSuccess,
}: {
  open: boolean;
  /** Absent for a create. */
  position?: Position;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const editing = !!position;
  const [form, setForm] = useState({
    code: position?.code ?? '',
    title: position?.title ?? '',
    department: position?.department ?? '',
    rankId: position?.rankId ?? '',
    headcount: String(position?.headcount ?? 1),
    description: position?.description ?? '',
    status: position?.status ?? 'active',
  });
  const [error, setError] = useState('');
  const jobRanks = useJobRanks();

  const mutation = useMutation({
    mutationFn: async () => {
      if (editing) {
        const { error: err } = await api.PATCH('/v1/positions/{id}', {
          params: { path: { id: position.id } },
          body: {
            title: form.title,
            department: form.department,
            rankId: form.rankId || null,
            headcount: Number(form.headcount),
            description: form.description || null,
            status: form.status as 'active' | 'frozen' | 'closed',
          },
        });
        if (err) throw new Error(apiErrorMessage(err, 'Failed to update the position.'));
        return;
      }
      const { error: err } = await api.POST('/v1/positions', {
        body: {
          code: form.code,
          title: form.title,
          department: form.department,
          rankId: form.rankId || undefined,
          headcount: Number(form.headcount),
          description: form.description || undefined,
        },
      });
      if (err) throw new Error(apiErrorMessage(err, 'Failed to create the position.'));
    },
    onSuccess: () => {
      toast.success(editing ? 'Position updated' : 'Position created');
      onSuccess();
      onClose();
    },
    onError: (e: Error) => setError(e.message),
  });

  function set<K extends keyof typeof form>(k: K, v: (typeof form)[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  return (
    <Modal open={open} onClose={onClose} title={editing ? 'Edit position' : 'New position'}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setError('');
          mutation.mutate();
        }}
        className="flex flex-col gap-4 p-5"
      >
        {!editing && (
          <FormField
            label="Code"
            htmlFor="pos-code"
            required
            hint="Quoted in contracts and training requirements. Cannot be changed later."
          >
            <Input
              id="pos-code"
              required
              value={form.code}
              onChange={(e) => set('code', e.target.value.toUpperCase())}
              placeholder="ENG-QA-01"
            />
          </FormField>
        )}

        <FormField label="Title" htmlFor="pos-title" required>
          <Input
            id="pos-title"
            required
            value={form.title}
            onChange={(e) => set('title', e.target.value)}
            placeholder="QA Engineer"
          />
        </FormField>

        <div className="grid grid-cols-2 gap-3">
          <FormField label="Department" htmlFor="pos-department" required>
            <Input
              id="pos-department"
              required
              value={form.department}
              onChange={(e) => set('department', e.target.value)}
              placeholder="Engineering"
            />
          </FormField>
          <FormField label="Rank" htmlFor="pos-rank">
            <Select
              id="pos-rank"
              value={form.rankId}
              onChange={(e) => set('rankId', e.target.value)}
            >
              <option value="">No rank</option>
              {(jobRanks.data ?? []).map((rank) => (
                <option key={rank.id} value={rank.id}>
                  {rank.name}
                </option>
              ))}
            </Select>
          </FormField>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <FormField
            label="Headcount"
            htmlFor="pos-headcount"
            required
            hint="How many people this position may hold at once."
          >
            <Input
              id="pos-headcount"
              type="number"
              min={0}
              required
              value={form.headcount}
              onChange={(e) => set('headcount', e.target.value)}
            />
          </FormField>
          {editing && (
            <FormField
              label="Status"
              htmlFor="pos-status"
              hint="Frozen keeps the position but takes no new assignments."
            >
              <Select
                id="pos-status"
                value={form.status}
                onChange={(e) => set('status', e.target.value)}
              >
                <option value="active">Active</option>
                <option value="frozen">Frozen</option>
                <option value="closed">Closed</option>
              </Select>
            </FormField>
          )}
        </div>

        <FormField label="Description" htmlFor="pos-description">
          <Textarea
            id="pos-description"
            value={form.description}
            onChange={(e) => set('description', e.target.value)}
            placeholder="What this role is responsible for…"
          />
        </FormField>

        <FormError message={error} />

        <FormActions
          loading={mutation.isPending}
          onClose={onClose}
          submitLabel={editing ? 'Save changes' : 'Create position'}
        />
      </form>
    </Modal>
  );
}

/**
 * Assign somebody to a position.
 *
 * The API refuses an assignment that would exceed the approved headcount (412
 * `POSITION_HEADCOUNT_EXCEEDED`) and refuses a second CURRENT position for one employee — a database
 * guarantee, not a check here. Both surface as the error text rather than being pre-empted, because a
 * client that duplicated those rules would be a second place for them to disagree.
 */
export function AssignPositionModal({
  position,
  onClose,
  onSuccess,
}: {
  position: Position;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [employeeId, setEmployeeId] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState(todayIso());
  const [error, setError] = useState('');

  const mutation = useMutation({
    mutationFn: async () => {
      const { error: err } = await api.POST('/v1/positions/{id}/assignments', {
        params: { path: { id: position.id } },
        body: { employeeId, effectiveFrom },
      });
      // The headcount rule and the one-current-position rule are the API's, and it says which one it
      // refused on. Naming both here would have been a guess about which applied.
      if (err) throw new Error(apiErrorMessage(err, 'Failed to assign the employee.'));
    },
    onSuccess: () => {
      toast.success('Assigned');
      onSuccess();
      onClose();
    },
    onError: (e: Error) => setError(e.message),
  });

  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      title={`Assign to ${position.title}`}
      description={`${position.filled} of ${position.headcount} filled`}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setError('');
          mutation.mutate();
        }}
        className="flex flex-col gap-4 p-5"
      >
        {/* Searched by name. This was a text box asking for a UUID, which meant opening the people
            screen and copying an id out of the URL to fill in a form. */}
        <FormField label="Employee" htmlFor="assign-employee" required>
          <EntityPicker
            id="assign-employee"
            queryKey="active-employees"
            value={employeeId}
            onChange={setEmployeeId}
            fetchOptions={activeEmployeeOptions}
            placeholder="Search people…"
          />
        </FormField>
        <FormField
          label="Effective from"
          htmlFor="assign-from"
          required
          hint="Back-dating is allowed: an assignment recorded late still started when it started."
        >
          <Input
            id="assign-from"
            type="date"
            required
            value={effectiveFrom}
            onChange={(e) => setEffectiveFrom(e.target.value)}
          />
        </FormField>

        <FormError message={error} />

        <FormActions
          loading={mutation.isPending}
          onClose={onClose}
          submitLabel="Assign"
          pendingLabel="Assigning…"
        />
      </form>
    </Modal>
  );
}
