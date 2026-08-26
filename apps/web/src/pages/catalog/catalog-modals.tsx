import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/shared/api/client';
import { apiErrorMessage } from '@/shared/api/errors';
import type { components } from '@/shared/api/types';
import {
  ConfirmDialog,
  FormActions,
  FormError,
  FormField,
  Input,
  Modal,
  Select,
  Textarea,
} from '@/shared/ui';
import type { CatalogItem } from './catalog-page';

type PermissionRow = components['schemas']['PermissionResponseDto'];

/** The categories the page groups by, and the only ones with an icon of their own. */
const CATEGORIES = ['hardware', 'software', 'access', 'hr', 'other'] as const;

/**
 * Publish or edit a catalog item.
 *
 * WHY THIS EXISTS. `POST /v1/catalog`, `PATCH /v1/catalog/:id` and `DELETE /v1/catalog/:id` have all
 * existed behind `catalog.manage` since the module was written, and the SPA called none of them. The
 * seed creates no items either. So the Service Catalog — a top-level nav section, and one of the two
 * journeys an internal ops platform is bought for — was permanently empty for every new tenant, with
 * an empty state that offered no way out of itself. Only a Playwright spec ever created an item, over
 * raw HTTP.
 *
 * `approvalPermission` IS A CHOICE, NOT A TEXT BOX. It is stored per item and decides nothing today —
 * `CatalogRequestTypeDef` hard-codes `catalog.approve` — but it is required on create, so a free-text
 * field invites a code that does not exist. The default in the schema (`requests.approve`) is exactly
 * that: a code absent from the permission catalogue. Offering the real list is the difference between
 * a field somebody can fill in correctly and a field somebody guesses at.
 */
export function CatalogItemModal({
  item,
  onClose,
  onSuccess,
}: {
  /** Absent when publishing something new. */
  item?: CatalogItem;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const editing = !!item;
  const [form, setForm] = useState({
    name: item?.name ?? '',
    description: item?.description ?? '',
    category: item?.category ?? 'hardware',
    iconEmoji: item?.iconEmoji ?? '',
    approvalPermission: item?.approvalPermission ?? 'catalog.approve',
    slaHours: item?.slaHours != null ? String(item.slaHours) : '',
  });
  const [error, setError] = useState('');

  /*
   * The real permission catalogue, from the API that serves the RBAC screen. Read-only here, and
   * cached under its own key so the two screens share one fetch.
   */
  const permissions = useQuery<PermissionRow[]>({
    queryKey: ['authz', 'permissions'],
    queryFn: async () => {
      const { data, error: err } = await api.GET('/v1/authz/permissions');
      if (err || !data) throw new Error('Failed to load the permission list');
      return data as PermissionRow[];
    },
  });

  const mutation = useMutation({
    mutationFn: async () => {
      const body = {
        name: form.name.trim(),
        description: form.description.trim() || null,
        category: form.category,
        iconEmoji: form.iconEmoji.trim() || null,
        approvalPermission: form.approvalPermission,
        // Empty means "no target", which the API models as null rather than as zero.
        slaHours: form.slaHours ? Number(form.slaHours) : null,
      };
      const { error: err } = editing
        ? await api.PATCH('/v1/catalog/{id}', { params: { path: { id: item.id } }, body })
        : await api.POST('/v1/catalog', { body });
      if (err) throw new Error(apiErrorMessage(err, 'Failed to save the catalog item.'));
    },
    onSuccess: () => {
      toast.success(editing ? 'Catalog item updated' : 'Catalog item published');
      onSuccess();
      onClose();
    },
    onError: (e: Error) => setError(e.message),
  });

  return (
    <Modal
      open
      onClose={onClose}
      title={editing ? `Edit ${item.name}` : 'Publish a catalog item'}
      description="What somebody can request, and who approves it."
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setError('');
          mutation.mutate();
        }}
        className="flex flex-col gap-4 p-5"
      >
        <FormField label="Name" htmlFor="cat-name" required>
          <Input
            id="cat-name"
            required
            maxLength={150}
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="Laptop replacement"
          />
        </FormField>

        <FormField
          label="Description"
          htmlFor="cat-description"
          hint="What the requester gets, and anything they should know before asking."
        >
          <Textarea
            id="cat-description"
            rows={3}
            maxLength={1000}
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
          />
        </FormField>

        <FormField label="Category" htmlFor="cat-category" required>
          <Select
            id="cat-category"
            required
            value={form.category}
            onChange={(e) => setForm({ ...form, category: e.target.value })}
          >
            {CATEGORIES.map((category) => (
              <option key={category} value={category}>
                {category}
              </option>
            ))}
          </Select>
        </FormField>

        <FormField
          label="Approver permission"
          htmlFor="cat-permission"
          required
          hint="Who may approve a request for this item."
        >
          <Select
            id="cat-permission"
            required
            value={form.approvalPermission}
            onChange={(e) => setForm({ ...form, approvalPermission: e.target.value })}
          >
            {(permissions.data ?? []).map((permission) => (
              <option key={permission.key} value={permission.key}>
                {permission.key} — {permission.description}
              </option>
            ))}
          </Select>
        </FormField>

        <FormField
          label="Decision target (hours)"
          htmlFor="cat-sla"
          hint="Hours to a DECISION, not to fulfilment — fulfilment is manual once approved. Leave empty for no target."
        >
          <Input
            id="cat-sla"
            type="number"
            min={1}
            value={form.slaHours}
            onChange={(e) => setForm({ ...form, slaHours: e.target.value })}
          />
        </FormField>

        <FormField
          label="Icon"
          htmlFor="cat-icon"
          hint="One emoji, optional. The category's own icon is used when this is empty."
        >
          <Input
            id="cat-icon"
            maxLength={10}
            value={form.iconEmoji}
            onChange={(e) => setForm({ ...form, iconEmoji: e.target.value })}
            placeholder="🖥"
          />
        </FormField>

        <FormError message={error} />
        <FormActions
          loading={mutation.isPending}
          onClose={onClose}
          submitLabel={editing ? 'Save' : 'Publish'}
        />
      </form>
    </Modal>
  );
}

/**
 * Withdraw an item from the catalog.
 *
 * A HARD DELETE, and the confirmation says so. `DELETE /v1/catalog/:id` removes the row; the only
 * trace is the audit entry. Requests already raised against it survive, because they are engine rows
 * of their own — which is worth saying, since "delete the thing people asked for" reads worse than it
 * is.
 */
export function DeleteCatalogItemDialog({
  item,
  onClose,
  onSuccess,
}: {
  item: CatalogItem;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const mutation = useMutation({
    mutationFn: async () => {
      const { error } = await api.DELETE('/v1/catalog/{id}', {
        params: { path: { id: item.id } },
      });
      if (error) throw new Error(apiErrorMessage(error, 'Failed to remove the catalog item.'));
    },
    onSuccess: () => {
      toast.success(`"${item.name}" removed from the catalog`);
      onSuccess();
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <ConfirmDialog
      open
      title={`Remove ${item.name}?`}
      description="Nobody will be able to request it. Requests already raised against it are unaffected. This cannot be undone."
      confirmLabel="Remove"
      variant="danger"
      loading={mutation.isPending}
      onConfirm={() => mutation.mutate()}
      onCancel={onClose}
    />
  );
}
