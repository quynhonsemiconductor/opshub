import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, Clock, Package, Pencil, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/shared/api/client';
import {
  Button,
  FormActions,
  FormField,
  IconAction,
  Modal,
  PageHeader,
  Textarea,
  humanizeStatus,
} from '@/shared/ui';
import { usePermissions } from '@/shared/hooks/use-permissions';
import { CatalogItemModal, DeleteCatalogItemDialog } from './catalog-modals';
import type { components } from '@/shared/api/types';

export type CatalogItem = components['schemas']['CatalogItemResponseDto'];

/*
 * WHAT THIS SCREEN NO LONGER CARRIES
 *
 * A hand-written `CatalogItem` interface and raw `sessionFetch` calls — the same pattern finops had,
 * and the routes have been in the generated client all along. A `CATEGORY_LABEL` map whose values were
 * emoji-prefixed strings (`'🖥 Hardware'`), so the emoji was data rather than presentation and a
 * category the map did not know rendered as a bare slug. And its own `SuccessToast` component — a
 * fixed-position box with a dismiss button — in an app that mounts `sonner` and uses `toast()`
 * everywhere else.
 *
 * The minimum-length rule on the reason was enforced only by disabling the button, which tells
 * somebody who has typed three characters nothing about why they cannot continue.
 */

/** Emoji per category, as PRESENTATION. The label itself comes from `humanizeStatus`. */
const CATEGORY_EMOJI: Record<string, string> = {
  hardware: '🖥',
  software: '💿',
  access: '🔑',
  hr: '👤',
  other: '📋',
};

const MIN_REASON = 10;
const MAX_REASON = 1000;

function useCatalogItems() {
  return useQuery({
    queryKey: ['catalog', 'items'],
    queryFn: async () => {
      const { data, error } = await api.GET('/v1/catalog');
      if (error || !data) throw new Error('Failed to load the catalog');
      return data;
    },
  });
}

function RequestModal({
  item,
  onClose,
  onSuccess,
}: {
  item: CatalogItem;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');

  const mutation = useMutation({
    mutationFn: async () => {
      const { error: err } = await api.POST('/v1/catalog/{id}/request', {
        params: { path: { id: item.id } },
        body: { reason },
      });
      if (err) throw new Error('Failed to submit the request');
    },
    onSuccess,
    onError: (err: Error) => setError(err.message),
  });

  const tooShort = reason.trim().length < MIN_REASON;

  return (
    <Modal
      open
      onClose={onClose}
      title={`Request ${item.name}`}
      description={item.slaHours ? `Fulfilled within ${item.slaHours}h once approved` : undefined}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          // Stated rather than silently disabled: a greyed-out button tells somebody who typed three
          // characters nothing about why they cannot continue.
          if (tooShort) {
            setError(`Please give at least ${MIN_REASON} characters of context.`);
            return;
          }
          setError('');
          mutation.mutate();
        }}
        className="flex flex-col gap-4 p-5"
      >
        {item.description && <p className="text-sm text-fg-muted">{item.description}</p>}

        <FormField
          label="Why do you need this?"
          htmlFor="catalog-reason"
          required
          error={error}
          hint={`${reason.trim().length} / ${MAX_REASON} characters`}
        >
          <Textarea
            id="catalog-reason"
            rows={4}
            maxLength={MAX_REASON}
            value={reason}
            error={error}
            onChange={(e) => setReason(e.target.value)}
            placeholder="What is it for, and when do you need it?"
          />
        </FormField>

        <FormActions
          loading={mutation.isPending}
          onClose={onClose}
          submitLabel="Submit request"
          pendingLabel="Submitting…"
        />
      </form>
    </Modal>
  );
}

/** One requestable item. A `<button>` because the whole card is the action. */
function ItemCard({
  item,
  onRequest,
  onEdit,
  onDelete,
}: {
  item: CatalogItem;
  onRequest: (i: CatalogItem) => void;
  /* Absent for a caller without `catalog.manage`: the card is then request-only, as it always was. */
  onEdit?: (i: CatalogItem) => void;
  onDelete?: (i: CatalogItem) => void;
}) {
  /*
   * A DIV WRAPPING A BUTTON, not a button wrapping everything. The whole card used to be one
   * `<button>`, which is why the manage actions could not simply be added inside it: a button inside a
   * button is invalid HTML and the inner one is unreachable by keyboard. The request area stays the
   * button; Edit and Remove are siblings.
   */
  return (
    <div className="group relative flex h-full flex-col rounded-xl border border-border bg-surface transition-colors hover:bg-surface-hover">
      {(onEdit || onDelete) && (
        <div className="absolute right-2 top-2 z-10 flex items-center gap-0.5">
          {onEdit && (
            <IconAction icon={Pencil} label={`Edit ${item.name}`} onClick={() => onEdit(item)} />
          )}
          {onDelete && (
            <IconAction
              icon={Trash2}
              label={`Remove ${item.name}`}
              tone="danger"
              onClick={() => onDelete(item)}
            />
          )}
        </div>
      )}
      <button
        type="button"
        onClick={() => onRequest(item)}
        className="flex h-full flex-col gap-2 rounded-xl p-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        <div className="flex items-start justify-between gap-2">
          <span className="text-2xl" aria-hidden="true">
            {item.iconEmoji ?? CATEGORY_EMOJI[item.category] ?? '📋'}
          </span>
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-fg">{item.name}</p>
          {item.description && (
            <p className="mt-0.5 line-clamp-2 text-xs text-fg-muted">{item.description}</p>
          )}
        </div>
        <div className="flex items-center justify-between gap-2">
          {item.slaHours ? (
            <span className="inline-flex items-center gap-1 text-xs text-fg-subtle">
              <Clock className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
              {/*
                A DECISION target, not an SLA on delivery. `CatalogRequestTypeDef.onApprove` is empty
                with the comment "Fulfillment is manual (IT team action)" — so the card used to promise
                a service level nothing measures, and the item's hours are in fact the auto-cancel
                deadline the engine applies to the request.
              */}
              Decision within {item.slaHours}h
            </span>
          ) : (
            <span />
          )}
          <ChevronRight
            className="h-4 w-4 shrink-0 text-fg-subtle transition-colors group-hover:text-fg-muted"
            strokeWidth={1.75}
            aria-hidden="true"
          />
        </div>
      </button>
    </div>
  );
}

export function CatalogPage() {
  const qc = useQueryClient();
  const { data: items, isLoading, isError } = useCatalogItems();
  const { can } = usePermissions();
  const canManage = can('catalog.manage');
  const [requesting, setRequesting] = useState<CatalogItem | null>(null);
  const [editing, setEditing] = useState<CatalogItem | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [deleting, setDeleting] = useState<CatalogItem | null>(null);

  const rows = items ?? [];
  const categories = [...new Set(rows.map((i) => i.category))].sort();

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Service Catalog"
        // "a decision target", not "an SLA": fulfilment is manual once approved, and the item's hours
        // are the deadline for the DECISION. The old sentence promised a service level nothing measures.
        description="Request hardware, software, access and more. Every item names who approves it and a target for the decision."
        actions={
          canManage ? (
            <Button onClick={() => setPublishing(true)}>Publish an item</Button>
          ) : undefined
        }
      />

      {isLoading && <p className="py-10 text-center text-sm text-fg-subtle">Loading…</p>}
      {isError && (
        <p className="py-10 text-center text-sm text-danger">Failed to load the catalog.</p>
      )}

      {/*
        AN EMPTY STATE THAT OFFERS THE WAY OUT OF ITSELF. The catalog ships with nothing in it and the
        seed adds nothing, so this is the FIRST thing every new tenant sees on this page — and it used
        to be a sentence and an icon, on a screen whose create route had no caller at all. For somebody
        who cannot publish, it says who can, rather than leaving them to wonder whether it is broken.
      */}
      {!isLoading && !isError && rows.length === 0 && (
        <div className="flex flex-col items-center gap-3 py-12 text-center">
          <Package className="h-8 w-8 text-fg-subtle" strokeWidth={1.5} />
          <span className="text-sm text-fg-subtle">Nothing in the catalog yet</span>
          {canManage ? (
            <Button onClick={() => setPublishing(true)}>Publish the first item</Button>
          ) : (
            <span className="text-xs text-fg-subtle">
              Ask IT to publish the services your team requests.
            </span>
          )}
        </div>
      )}

      {categories.map((category) => (
        <section key={category} className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-fg">
            <span className="mr-1.5" aria-hidden="true">
              {CATEGORY_EMOJI[category] ?? '📋'}
            </span>
            {humanizeStatus(category)}
          </h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {rows
              .filter((i) => i.category === category)
              .map((item) => (
                <ItemCard
                  key={item.id}
                  item={item}
                  onRequest={setRequesting}
                  onEdit={canManage ? setEditing : undefined}
                  onDelete={canManage ? setDeleting : undefined}
                />
              ))}
          </div>
        </section>
      ))}

      {requesting && (
        <RequestModal
          item={requesting}
          onClose={() => setRequesting(null)}
          onSuccess={() => {
            void qc.invalidateQueries({ queryKey: ['requests'] });
            // The app's own toaster, not a bespoke box: one place decides how a success looks.
            toast.success('Request submitted', {
              description: `"${requesting.name}" — you will be notified when it is approved.`,
            });
            setRequesting(null);
          }}
        />
      )}

      {/* Publishing and editing share one form: the fields are identical and the API differs only in
          verb, so a second component would be the same file with a different title. */}
      {(publishing || editing) && (
        <CatalogItemModal
          item={editing ?? undefined}
          onClose={() => {
            setPublishing(false);
            setEditing(null);
          }}
          onSuccess={() => void qc.invalidateQueries({ queryKey: ['catalog'] })}
        />
      )}

      {deleting && (
        <DeleteCatalogItemDialog
          item={deleting}
          onClose={() => setDeleting(null)}
          onSuccess={() => void qc.invalidateQueries({ queryKey: ['catalog'] })}
        />
      )}
    </div>
  );
}
