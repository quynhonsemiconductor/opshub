import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ShieldCheck, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/shared/api/client';
import { apiErrorMessage } from '@/shared/api/errors';
import {
  ActivityTimeline,
  Button,
  ConfirmDialog,
  DataTable,
  DescriptionList,
  FormActions,
  FormError,
  FormField,
  Input,
  ListPage,
  Modal,
  PanelAction,
  RowAction,
  RowActions,
  SegmentedControl,
  Select,
  SlideOver,
  SlideOverSection,
  StatusBadge,
  Textarea,
  humanizeStatus,
  statusTone,
  type DataTableColumn,
} from '@/shared/ui';
import { useListState } from '@/shared/hooks/use-list-state';
import { usePermissions } from '@/shared/hooks/use-permissions';
import { formatDate, formatDateTime } from '@/shared/lib/format';
import { MyGrantsPanel } from './my-grants-panel';
import { useAccessRequests } from './use-access';
import type {
  AccessGrantResponse,
  AccessRequestResponse,
  AccessRequestStatus,
} from '@/shared/api/types';

const ACCESS_TYPE_OPTIONS = [
  { value: 'local_admin', label: 'Local Admin' },
  { value: 'pim_role', label: 'PIM Role (JIT elevation)' },
  { value: 'app_admin', label: 'App Admin' },
  { value: 'vpn', label: 'VPN' },
  { value: 'other', label: 'Other' },
] as const;
type AccessType = (typeof ACCESS_TYPE_OPTIONS)[number]['value'];

/*
 * NO LOCAL STATUS LABEL OR COLOUR MAPS.
 *
 * They used to live here — `pending` was amber, `expired` was a raw `bg-surface-muted` pair — and the
 * inbox, workforce and catalog screens each had their own copy that disagreed. `statusTone` owns which
 * tone a word MEANS and `StatusBadge` owns what a tone LOOKS like, so the same status is the same
 * colour everywhere and a new screen cannot invent a seventh.
 */

const STATUS_FILTERS = [
  { value: '' as const, label: 'All' },
  { value: 'pending' as const, label: 'Pending' },
  { value: 'approved' as const, label: 'Approved' },
  { value: 'rejected' as const, label: 'Rejected' },
];

// ── Submit modal ──────────────────────────────────────────────────────────────

interface SubmitModalProps {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

/**
 * The request form.
 *
 * On `Modal`, which was already in the codebase and which this page — like nine others — had
 * reimplemented as a bare `fixed inset-0` overlay with NO `role="dialog"`, no focus trap, no Escape
 * and no scroll lock. Keyboard users could tab into the page behind it and screen readers were never
 * told a dialog had opened.
 */
function SubmitModal({ open, onClose, onSuccess }: SubmitModalProps) {
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [form, setForm] = useState({
    accessType: 'vpn' as AccessType,
    target: '',
    justification: '',
    durationHours: 8,
  });

  function set<K extends keyof typeof form>(k: K, v: (typeof form)[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setErr('');
    const { error } = await api.POST('/v1/access-requests', {
      body: {
        accessType: form.accessType,
        target: form.target,
        justification: form.justification,
        durationHours: form.durationHours,
      },
    });
    setLoading(false);
    if (error) {
      /*
       * The commonest refusal here is the 10-character minimum on `justification`, which the form
       * does not state — so "please try again" sent the user round the same loop with the same text.
       */
      setErr(apiErrorMessage(error, 'Failed to submit the request.'));
      return;
    }
    toast.success('Access request submitted');
    onSuccess();
    onClose();
  }

  return (
    <Modal open={open} onClose={onClose} title="Request temporary access">
      <form id="access-request-form" onSubmit={onSubmit} className="flex flex-col gap-4 p-5">
        <FormField label="Access type" htmlFor="access-type" required>
          <Select
            id="access-type"
            required
            value={form.accessType}
            onChange={(e) => set('accessType', e.target.value as AccessType)}
          >
            {ACCESS_TYPE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </FormField>

        <FormField label="Target system / resource" htmlFor="access-target" required>
          <Input
            id="access-target"
            required
            value={form.target}
            onChange={(e) => set('target', e.target.value)}
            placeholder="e.g. prod-db-01, 10.0.0.5, s3://my-bucket"
          />
        </FormField>

        <FormField label="Justification" htmlFor="access-justification" required>
          <Textarea
            id="access-justification"
            required
            value={form.justification}
            onChange={(e) => set('justification', e.target.value)}
            placeholder="Why do you need this access and for what purpose?"
          />
        </FormField>

        <FormField
          label="Duration (hours)"
          htmlFor="access-duration"
          hint="Maximum 720 hours (30 days). Access is automatically revoked after expiry."
        >
          <Input
            id="access-duration"
            type="number"
            min={1}
            max={720}
            required
            value={form.durationHours}
            onChange={(e) => set('durationHours', Number(e.target.value))}
          />
        </FormField>

        <FormError message={err} />

        <FormActions
          loading={loading}
          onClose={onClose}
          submitLabel="Submit request"
          pendingLabel="Submitting…"
        />
      </form>
    </Modal>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

/**
 * The table's columns.
 *
 * Declared outside the component so the array is not rebuilt every render, and taking the handlers as
 * an argument because the actions column needs them.
 */
function accessColumns(actions: {
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
}): DataTableColumn<AccessRequestResponse>[] {
  return [
    {
      key: 'accessType',
      header: 'Access type',
      cell: (r) => <span className="font-mono text-xs font-medium text-fg">{r.accessType}</span>,
    },
    { key: 'target', header: 'Target', cell: (r) => r.target },
    { key: 'duration', header: 'Duration', cell: (r) => `${r.durationHours}h`, hideOnMobile: true },
    {
      key: 'status',
      header: 'Status',
      cell: (r) => (
        <StatusBadge tone={statusTone(r.status)}>{humanizeStatus(r.status)}</StatusBadge>
      ),
    },
    {
      key: 'requested',
      header: 'Requested',
      cell: (r) => <span className="text-xs text-fg-subtle">{formatDate(r.createdAt)}</span>,
      hideOnMobile: true,
    },
    {
      key: 'actions',
      header: 'Actions',
      // `stopPropagation` because the row opens the detail panel: without it, approving also opens it.
      cell: (r) => (
        <div onClick={(e) => e.stopPropagation()}>
          {r.status === 'pending' && (
            // `RowAction`s from the kit, not two hand-rolled buttons carrying their own tone classes —
            // the duplication `RowActions` exists to remove, and the same pair the inbox now uses.
            <RowActions>
              <RowAction tone="success" onClick={() => actions.onApprove(r.id)}>
                Approve
              </RowAction>
              <RowAction tone="danger" onClick={() => actions.onReject(r.id)}>
                Reject
              </RowAction>
            </RowActions>
          )}
          {r.status === 'approved' && r.reviewedAt && (
            <span className="text-xs text-fg-subtle">Approved {formatDate(r.reviewedAt)}</span>
          )}
          {r.status === 'rejected' && r.reviewNote && (
            <span className="text-xs text-fg-subtle" title={r.reviewNote}>
              Rejected — {r.reviewNote.slice(0, 30)}
              {r.reviewNote.length > 30 ? '…' : ''}
            </span>
          )}
        </div>
      ),
    },
  ];
}

export function AccessPage() {
  const qc = useQueryClient();
  const { can } = usePermissions();
  /*
   * REVOKING IS THE SAME PERMISSION AS APPROVING, and that is the API's choice, not a shortcut here:
   * `grants/{grantId}/revoke` is guarded by `access_request.security_approve`. Whoever may grant elevation
   * may take it back, and nobody else — including the holder, who can READ their own grants
   * (`grants/me/active` is `@SelfScoped`) but cannot end one.
   */
  const canRevoke = can('access_request.security_approve');

  const [statusFilter, setStatusFilter] = useState<AccessRequestStatus | ''>('');
  const [showForm, setShowForm] = useState(false);
  const [selected, setSelected] = useState<AccessRequestResponse | null>(null);
  const [revoking, setRevoking] = useState<AccessGrantResponse | null>(null);
  const list = useListState();

  const requests = useAccessRequests(statusFilter, list.limit, list.offset);
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['access-requests'] });
  };

  async function handleApprove(id: string) {
    const { error } = await api.POST('/v1/access-requests/{id}/approve', {
      params: { path: { id } },
      body: {},
    });
    if (error) {
      toast.error(apiErrorMessage(error, 'Failed to approve request.'));
      return;
    }
    toast.success('Request approved — time-boxed grant issued');
    invalidate();
  }

  async function handleReject(id: string) {
    const { error } = await api.POST('/v1/access-requests/{id}/reject', {
      params: { path: { id } },
      body: {},
    });
    if (error) {
      toast.error(apiErrorMessage(error, 'Failed to reject request.'));
      return;
    }
    toast.success('Request rejected');
    invalidate();
  }

  async function revokeGrant() {
    if (!revoking) return;
    const { error } = await api.POST('/v1/access-requests/grants/{grantId}/revoke', {
      params: { path: { grantId: revoking.id } },
    });
    setRevoking(null);
    if (error) {
      toast.error(apiErrorMessage(error, 'Failed to revoke the grant.'));
      return;
    }
    toast.success('Access revoked');
    invalidate();
  }

  return (
    <>
      <SubmitModal open={showForm} onClose={() => setShowForm(false)} onSuccess={invalidate} />

      {/* The API's own precondition, said before the act: revoking is immediate and one-way. A grant is
          `ACCESS_GRANT_NOT_ACTIVE` once revoked, so there is no un-revoke — the route back is a new
          request through the same approval it came from. */}
      <ConfirmDialog
        open={!!revoking}
        variant="danger"
        onCancel={() => setRevoking(null)}
        onConfirm={revokeGrant}
        title="Revoke this access now?"
        description={
          revoking
            ? `${humanizeStatus(revoking.accessType)} on ${revoking.target} ends immediately, rather than when its window closes at ${formatDateTime(revoking.expiresAt)}. Getting it back means requesting it again.`
            : undefined
        }
        confirmLabel="Revoke access"
      />

      <ListPage
        title="Access Requests"
        description="Request and manage temporary privileged access to systems and resources."
        actions={
          <Button variant="primary" onClick={() => setShowForm(true)}>
            <Plus className="h-4 w-4" strokeWidth={2} />
            Request access
          </Button>
        }
        filters={
          <SegmentedControl
            label="Filter by status"
            options={STATUS_FILTERS}
            value={statusFilter}
            onChange={(value) => {
              setStatusFilter(value);
              // Narrowing the set invalidates the offset — page 3 of the pending ones may not exist.
              list.resetPaging();
            }}
          />
        }
        pageInfo={requests.data?.pageInfo}
        onOffsetChange={list.goToOffset}
        noun="requests"
      >
        {/* Above the list, because "what am I already holding" outranks "ask for more" — and it renders
            nothing at all when the answer is none. */}
        <MyGrantsPanel canRevoke={canRevoke} onRevoke={setRevoking} />

        <DataTable
          columns={accessColumns({ onApprove: handleApprove, onReject: handleReject })}
          rows={requests.data?.data as AccessRequestResponse[] | undefined}
          isLoading={requests.isLoading}
          isError={requests.isError}
          errorMessage="Failed to load requests. Is the API running?"
          emptyMessage="No access requests found"
          emptyIcon={ShieldCheck}
          onRowClick={setSelected}
          isRowActive={(r) => r.id === selected?.id}
        />
      </ListPage>

      <SlideOver
        open={!!selected}
        onClose={() => setSelected(null)}
        title={selected?.accessType ?? 'Access request'}
        description={selected ? `${selected.target} · ${selected.durationHours}h` : undefined}
        width="lg"
        headerActions={
          selected?.status === 'pending' ? (
            <>
              <PanelAction
                tone="success"
                onClick={() => {
                  handleApprove(selected.id);
                  setSelected(null);
                }}
              >
                Approve
              </PanelAction>
              <PanelAction
                tone="danger"
                onClick={() => {
                  handleReject(selected.id);
                  setSelected(null);
                }}
              >
                Reject
              </PanelAction>
            </>
          ) : undefined
        }
      >
        {selected && (
          <>
            <SlideOverSection title="Details">
              <DescriptionList
                items={[
                  { label: 'Access type', value: selected.accessType },
                  { label: 'Target', value: selected.target },
                  { label: 'Duration', value: `${selected.durationHours}h` },
                  {
                    label: 'Status',
                    value: (
                      <StatusBadge tone={statusTone(selected.status)}>
                        {humanizeStatus(selected.status)}
                      </StatusBadge>
                    ),
                  },
                  { label: 'Requested', value: formatDate(selected.createdAt) },
                  // No `?? '—'`: DescriptionList renders the em dash for an absent value, which is
                  // what makes it consistent across every panel rather than per call site.
                  { label: 'Reviewed', value: formatDate(selected.reviewedAt) },
                  { label: 'Justification', value: selected.justification, wide: true },
                  { label: 'Review note', value: selected.reviewNote, wide: true },
                ]}
              />
            </SlideOverSection>

            <div className="mx-5 h-px bg-surface-muted" />

            <SlideOverSection title="Activity">
              <ActivityTimeline resourceId={selected.id} resourceType="access_request" />
            </SlideOverSection>
          </>
        )}
      </SlideOver>
    </>
  );
}
