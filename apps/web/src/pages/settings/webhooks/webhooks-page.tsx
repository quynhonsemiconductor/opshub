import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, Webhook } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/shared/api/client';
import { apiErrorMessage } from '@/shared/api/errors';
import {
  Badge,
  Button,
  ConfirmDialog,
  DataTable,
  EntityDetailPanel,
  IconAction,
  ListPage,
  RowAction,
  RowActions,
  SlideOverSection,
  StatusBadge,
  humanizeStatus,
  statusTone,
  type BadgeTone,
  type DataTableColumn,
} from '@/shared/ui';
import { usePermissions } from '@/shared/hooks/use-permissions';
import { formatDate, formatDateTime, orDash } from '@/shared/lib/format';
import { CreateSubscriptionModal } from './create-subscription-modal';
import type { WebhookSubscription } from './webhook.types';

/*
 * WHAT THIS SCREEN NO LONGER CARRIES
 *
 * An `EventBadge` with a six-entry colour map, a `DeliveryStatusBadge` with a nested ternary, a
 * hand-rolled dialog, an `inputClass`, four raw header cells plus four more for the nested deliveries
 * table, a `dl` grid, and its own date formatting in two places.
 *
 * A delivery's status vocabulary — delivered / pending / failed — now goes through the shared tone map
 * like every other status in the product.
 */

/** Event → tone. This screen's own vocabulary: nothing else lists webhook event types. */
const EVENT_TONE: Record<string, BadgeTone> = {
  'request.submitted': 'blue',
  'request.step_approved': 'violet',
  'request.approved': 'green',
  'request.rejected': 'red',
  'request.cancelled': 'neutral',
  'request.expired': 'amber',
};

function useSubscriptions() {
  return useQuery({
    queryKey: ['webhooks', 'subscriptions'],
    queryFn: async () => {
      const { data, error } = await api.GET('/v1/webhooks/subscriptions');
      if (error || !data) throw new Error('Failed to load subscriptions');
      return data;
    },
  });
}

function useDeliveries(subId: string | null) {
  return useQuery({
    queryKey: ['webhooks', 'deliveries', subId],
    enabled: !!subId,
    queryFn: async () => {
      const { data, error } = await api.GET('/v1/webhooks/subscriptions/{id}/deliveries', {
        params: { path: { id: subId! } },
      });
      if (error || !data) throw new Error('Failed to load deliveries');
      return data;
    },
  });
}

export function WebhooksPage() {
  const qc = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [selected, setSelected] = useState<WebhookSubscription | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  /*
   * GATED ON THE PERMISSION THE API ENFORCES. All eight webhook routes carry
   * `@RequirePermission('webhooks.manage')`, and this page offered Create, Enable/Disable and Delete
   * with no check. The nav item that leads here already gates on `webhooks.manage`, so in practice this
   * was reachable only by a holder — but the page must not depend on the nav being right, and until
   * recently those routes required `rbac.manage` instead, so the nav and the routes disagreed.
   */
  const canManage = usePermissions().can('webhooks.manage');

  const subscriptions = useSubscriptions();
  const deliveries = useDeliveries(selected?.id ?? null);
  const invalidate = () => qc.invalidateQueries({ queryKey: ['webhooks'] });

  /*
   * RETRY IS OFFERED ONLY ON A DELIVERY THAT FAILED, and that is the screen's judgement rather than the
   * API's: `retryDelivery` sets any delivery back to `pending` with a fresh `nextAttemptAt` and checks no
   * status at all, so a DELIVERED event would be re-sent to the endpoint on a click. The route's own summary
   * says "failed webhook delivery"; the code does not enforce it, so this does.
   */
  async function retryDelivery(deliveryId: string) {
    const { error } = await api.POST('/v1/webhooks/deliveries/{id}/retry', {
      params: { path: { id: deliveryId } },
    });
    if (error) {
      toast.error(apiErrorMessage(error, 'Failed to queue the retry.'));
      return;
    }
    // Queued, not sent: the worker picks it up on its next pass, so the row goes back to `pending` rather
    // than straight to `delivered`. Saying "retried" would claim an outcome nobody has yet.
    toast.success('Retry queued');
    invalidate();
  }

  const toggle = useMutation({
    mutationFn: async (sub: WebhookSubscription) => {
      const { error } = await api.PATCH('/v1/webhooks/subscriptions/{id}/active', {
        params: { path: { id: sub.id } },
        body: { active: !sub.active },
      });
      if (error) throw new Error(apiErrorMessage(error, 'Failed to update the subscription.'));
    },
    onSuccess: () => {
      toast.success('Subscription updated');
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await api.DELETE('/v1/webhooks/subscriptions/{id}', {
        params: { path: { id } },
      });
      if (error) throw new Error(apiErrorMessage(error, 'Failed to delete the subscription.'));
    },
    onSuccess: () => {
      toast.success('Subscription deleted');
      setPendingDeleteId(null);
      setSelected(null);
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const columns: DataTableColumn<WebhookSubscription>[] = [
    {
      key: 'url',
      header: 'Endpoint',
      cell: (sub) => <span className="break-all font-mono text-xs text-fg">{sub.url}</span>,
    },
    {
      key: 'events',
      header: 'Events',
      cell: (sub) => (
        <div className="flex flex-wrap gap-1">
          {sub.events.map((e) => (
            <Badge key={e} tone={EVENT_TONE[e] ?? 'neutral'}>
              {e}
            </Badge>
          ))}
        </div>
      ),
      hideOnMobile: true,
    },
    {
      key: 'created',
      header: 'Created',
      cell: (sub) => formatDate(sub.createdAt),
      hideOnMobile: true,
    },
    {
      key: 'status',
      header: 'Status',
      cell: (sub) => (
        <StatusBadge tone={statusTone(sub.active ? 'active' : 'archived')}>
          {sub.active ? 'Active' : 'Inactive'}
        </StatusBadge>
      ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: (sub) => (
        <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
          {canManage && (
            <Button
              variant="outline"
              size="sm"
              disabled={toggle.isPending}
              onClick={() => toggle.mutate(sub)}
            >
              {sub.active ? 'Disable' : 'Enable'}
            </Button>
          )}
          {canManage && (
            <IconAction
              label={`Delete subscription for ${sub.url}`}
              icon={Trash2}
              tone="danger"
              onClick={() => setPendingDeleteId(sub.id)}
            />
          )}
        </div>
      ),
    },
  ];

  return (
    <>
      <CreateSubscriptionModal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        onSuccess={invalidate}
      />

      <ConfirmDialog
        open={!!pendingDeleteId}
        onCancel={() => setPendingDeleteId(null)}
        onConfirm={() => pendingDeleteId && remove.mutate(pendingDeleteId)}
        loading={remove.isPending}
        variant="danger"
        title="Delete subscription?"
        description="Events stop being delivered to this endpoint immediately. Past deliveries are kept."
        confirmLabel="Delete subscription"
      />

      <ListPage
        title="Webhooks"
        description="Outbound event delivery: which endpoints hear about what, and whether it arrived."
        actions={
          canManage ? (
            <Button variant="primary" onClick={() => setShowCreate(true)}>
              <Plus className="h-4 w-4" strokeWidth={2} />
              New subscription
            </Button>
          ) : undefined
        }
      >
        <DataTable
          columns={columns}
          rows={subscriptions.data as WebhookSubscription[] | undefined}
          isLoading={subscriptions.isLoading}
          isError={subscriptions.isError}
          errorMessage="Failed to load subscriptions."
          emptyMessage="No endpoints subscribed yet"
          emptyIcon={Webhook}
          emptyAction={
            !canManage ? undefined : (
              <Button variant="primary" size="sm" onClick={() => setShowCreate(true)}>
                <Plus className="h-3.5 w-3.5" /> Create your first subscription
              </Button>
            )
          }
          onRowClick={setSelected}
          isRowActive={(sub) => sub.id === selected?.id}
        />
      </ListPage>

      <EntityDetailPanel
        open={!!selected}
        onClose={() => setSelected(null)}
        width="lg"
        title="Subscription"
        description={selected?.url}
        items={
          selected
            ? [
                {
                  label: 'Endpoint',
                  wide: true,
                  value: <span className="break-all font-mono text-sm">{selected.url}</span>,
                },
                {
                  label: 'Status',
                  value: (
                    <StatusBadge tone={statusTone(selected.active ? 'active' : 'archived')}>
                      {selected.active ? 'Active' : 'Inactive'}
                    </StatusBadge>
                  ),
                },
                { label: 'Created', value: formatDateTime(selected.createdAt) },
                { label: 'Description', value: selected.description, wide: true },
                {
                  label: 'Events',
                  wide: true,
                  value: (
                    <div className="flex flex-wrap gap-1">
                      {selected.events.map((e) => (
                        <Badge key={e} tone={EVENT_TONE[e] ?? 'neutral'}>
                          {e}
                        </Badge>
                      ))}
                    </div>
                  ),
                },
              ]
            : []
        }
      >
        {selected && (
          <SlideOverSection title="Recent deliveries">
            {/* The nested table is a `DataTable` too — it had its own four headers and its own empty
                state before, which is how the two tables on one screen came to look different. */}
            <DataTable
              columns={[
                {
                  key: 'event',
                  header: 'Event',
                  cell: (d) => (
                    <Badge tone={EVENT_TONE[d.eventType] ?? 'neutral'}>{d.eventType}</Badge>
                  ),
                },
                {
                  key: 'status',
                  header: 'Status',
                  cell: (d) => (
                    <StatusBadge tone={statusTone(d.status)}>
                      {humanizeStatus(d.status)}
                    </StatusBadge>
                  ),
                },
                {
                  key: 'attempts',
                  header: 'Attempts',
                  align: 'right',
                  cell: (d) => d.attempts,
                },
                {
                  // `deliveredAt` for a success, `nextAttemptAt` for one still retrying — the field
                  // names come from the generated schema, where the old code guessed `lastAttemptAt`
                  // and `attemptCount`, neither of which exists.
                  key: 'when',
                  header: 'Delivered / next try',
                  cell: (d) => formatDateTime(d.deliveredAt ?? d.nextAttemptAt),
                },
                {
                  key: 'error',
                  header: 'Last error',
                  cell: (d) => <span className="text-xs text-danger">{orDash(d.lastError)}</span>,
                  className: 'max-w-[220px] truncate',
                  hideOnMobile: true,
                },
                {
                  key: 'actions',
                  header: '',
                  align: 'right',
                  cell: (d) =>
                    d.status === 'failed' ? (
                      <RowActions>
                        <RowAction tone="accent" onClick={() => void retryDelivery(d.id)}>
                          Retry
                        </RowAction>
                      </RowActions>
                    ) : null,
                },
              ]}
              rows={deliveries.data}
              isLoading={deliveries.isLoading}
              isError={deliveries.isError}
              errorMessage="Failed to load deliveries."
              emptyMessage="No deliveries yet"
              emptyIcon={Webhook}
            />
          </SlideOverSection>
        )}
      </EntityDetailPanel>
    </>
  );
}
