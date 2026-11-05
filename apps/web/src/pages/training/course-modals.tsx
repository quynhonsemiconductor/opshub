import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/shared/api/client';
import { apiErrorMessage } from '@/shared/api/errors';
import { FormActions, FormError, FormField, Input, Modal, Textarea } from '@/shared/ui';
import type { Course } from './training.types';

/**
 * Create or edit a course.
 *
 * The CODE is immutable, like a role's: requirements, records and certificates all quote it, so the
 * edit form omits the field rather than offering one the API would reject.
 *
 * VALIDITY IS WHAT MAKES A RECORD EXPIRE. `validityMonths` is optional, and its absence is a real
 * answer — an induction is done once and never expires — so the field is left empty rather than filled
 * with a sentinel. When it IS set, the API computes `expiresOn` from the completion date, which is why
 * the hint says so: somebody changing 12 to 24 is changing when everybody's certificate lapses.
 */
export function CourseModal({
  editing,
  open,
  onClose,
  onSuccess,
}: {
  editing: Course | null;
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [form, setForm] = useState({
    code: editing?.code ?? '',
    title: editing?.title ?? '',
    category: editing?.category ?? '',
    provider: editing?.provider ?? '',
    description: editing?.description ?? '',
    validityMonths: editing?.validityMonths != null ? String(editing.validityMonths) : '',
  });
  const [error, setError] = useState('');

  const mutation = useMutation({
    mutationFn: async () => {
      const shared = {
        title: form.title,
        category: form.category,
        provider: form.provider || null,
        description: form.description || null,
        // Empty means "never expires", which is not the same as zero months.
        validityMonths: form.validityMonths ? Number(form.validityMonths) : null,
      };
      if (editing) {
        const { error: err } = await api.PATCH('/v1/training/courses/{id}', {
          params: { path: { id: editing.id } },
          body: shared,
        });
        if (err) throw new Error(apiErrorMessage(err, 'Failed to update the course.'));
        return;
      }
      const { error: err } = await api.POST('/v1/training/courses', {
        body: { code: form.code, ...shared },
      });
      if (err) throw new Error(apiErrorMessage(err, 'Failed to create the course.'));
    },
    onSuccess: () => {
      toast.success(editing ? 'Course updated' : 'Course created');
      onSuccess();
      onClose();
    },
    onError: (e: Error) => setError(e.message),
  });

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  return (
    <Modal open={open} onClose={onClose} title={editing ? 'Edit course' : 'New course'}>
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
            htmlFor="course-code"
            required
            hint="Quoted by requirements and certificates. Cannot be changed later."
          >
            <Input
              id="course-code"
              required
              value={form.code}
              onChange={(e) => set('code', e.target.value.toUpperCase())}
              placeholder="ISO27001-AWARE"
            />
          </FormField>
        )}

        <FormField label="Title" htmlFor="course-title" required>
          <Input
            id="course-title"
            required
            value={form.title}
            onChange={(e) => set('title', e.target.value)}
            placeholder="Information Security Awareness"
          />
        </FormField>

        <div className="grid grid-cols-2 gap-3">
          <FormField label="Category" htmlFor="course-category" required>
            <Input
              id="course-category"
              required
              value={form.category}
              onChange={(e) => set('category', e.target.value)}
              placeholder="Compliance"
            />
          </FormField>
          <FormField label="Provider" htmlFor="course-provider">
            <Input
              id="course-provider"
              value={form.provider}
              onChange={(e) => set('provider', e.target.value)}
              placeholder="Internal"
            />
          </FormField>
        </div>

        <FormField
          label="Validity (months)"
          htmlFor="course-validity"
          hint="Leave empty for a course that never expires. Otherwise a record expires this long after completion."
        >
          <Input
            id="course-validity"
            type="number"
            min={1}
            value={form.validityMonths}
            onChange={(e) => set('validityMonths', e.target.value)}
            placeholder="12"
          />
        </FormField>

        <FormField label="Description" htmlFor="course-description">
          <Textarea
            id="course-description"
            value={form.description}
            onChange={(e) => set('description', e.target.value)}
          />
        </FormField>

        <FormError message={error} />

        <FormActions
          loading={mutation.isPending}
          onClose={onClose}
          submitLabel={editing ? 'Save course' : 'Create course'}
        />
      </form>
    </Modal>
  );
}
