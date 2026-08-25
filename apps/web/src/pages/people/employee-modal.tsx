import { useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/shared/api/client';
import { apiErrorMessage } from '@/shared/api/errors';
import { FormActions, FormError, FormField, Input, Modal } from '@/shared/ui';
import { RoleChip } from './people-shared';
import type { EmployeeResponse } from './people.types';

interface EmployeeModalProps {
  mode: 'create' | 'edit';
  employee?: EmployeeResponse;
  onClose: () => void;
  onSuccess: () => void;
}

/**
 * Create or edit a directory record.
 *
 * ROLES ARE DELIBERATELY NOT EDITABLE HERE. Role assignment is a governance action on
 * Settings → Access Control, enforced server-side with an escalation guard; this modal manages
 * profile fields. The chips are shown so the reader can see what the person holds without being
 * invited to change it here.
 */
export function EmployeeModal({ mode, employee, onClose, onSuccess }: EmployeeModalProps) {
  const [form, setForm] = useState({
    email: employee?.email ?? '',
    displayName: employee?.displayName ?? '',
    department: employee?.department ?? '',
    jobTitle: employee?.jobTitle ?? '',
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');

    if (mode === 'create') {
      const { error: err } = await api.POST('/v1/employees', {
        body: {
          email: form.email,
          displayName: form.displayName,
          department: form.department || undefined,
          jobTitle: form.jobTitle || undefined,
        },
      });
      if (err) {
        // "Employee jane@x.com already exists" is the API's answer and the only actionable one;
        // this slot replaced it with a sentence that names nothing.
        setError(apiErrorMessage(err, 'Failed to create the employee.'));
        setLoading(false);
        return;
      }
    } else if (employee) {
      const { error: err } = await api.PATCH('/v1/employees/{id}', {
        params: { path: { id: employee.id } },
        body: {
          displayName: form.displayName,
          department: form.department || null,
          jobTitle: form.jobTitle || null,
        },
      });
      if (err) {
        setError(apiErrorMessage(err, 'Failed to update the employee.'));
        setLoading(false);
        return;
      }
    }

    setLoading(false);
    toast.success(mode === 'create' ? 'Employee created' : 'Employee updated');
    onSuccess();
    onClose();
  }

  return (
    <Modal open onClose={onClose} title={mode === 'create' ? 'Add employee' : 'Edit employee'}>
      <form onSubmit={onSubmit} className="flex flex-col gap-4 p-5">
        {mode === 'create' && (
          <FormField label="Email" htmlFor="emp-email" required>
            <Input
              id="emp-email"
              type="email"
              required
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              placeholder="user@company.com"
            />
          </FormField>
        )}

        <FormField label="Display name" htmlFor="emp-name" required>
          <Input
            id="emp-name"
            required
            value={form.displayName}
            onChange={(e) => setForm({ ...form, displayName: e.target.value })}
            placeholder="Jane Smith"
          />
        </FormField>

        <div className="grid grid-cols-2 gap-3">
          <FormField label="Department" htmlFor="emp-department">
            <Input
              id="emp-department"
              value={form.department}
              onChange={(e) => setForm({ ...form, department: e.target.value })}
              placeholder="Engineering"
            />
          </FormField>
          <FormField label="Job title" htmlFor="emp-title">
            <Input
              id="emp-title"
              value={form.jobTitle}
              onChange={(e) => setForm({ ...form, jobTitle: e.target.value })}
              placeholder="Engineer"
            />
          </FormField>
        </div>

        <FormField label="Roles" hint="Roles are managed in Settings → Access Control.">
          {mode === 'edit' && employee && employee.roles.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {employee.roles.map((r) => (
                <RoleChip key={r} role={r} />
              ))}
            </div>
          ) : (
            <p className="text-xs text-fg-subtle">
              {mode === 'create' ? 'New employees start with no roles.' : 'No roles assigned.'}
            </p>
          )}
        </FormField>

        <FormError message={error} />

        <FormActions
          loading={loading}
          onClose={onClose}
          submitLabel={mode === 'create' ? 'Create' : 'Save changes'}
        />
      </form>
    </Modal>
  );
}
