import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { FileText, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/shared/api/client';
import { apiErrorMessage } from '@/shared/api/errors';
import {
  Badge,
  Button,
  ConfirmDialog,
  DataTable,
  EntityDetailPanel,
  ListPage,
  PanelAction,
  RowAction,
  RowActions,
  SegmentedControl,
  SlideOverSection,
  StatusBadge,
  humanizeStatus,
  statusTone,
  type DataTableColumn,
} from '@/shared/ui';
import { useListState } from '@/shared/hooks/use-list-state';
import { usePermissions } from '@/shared/hooks/use-permissions';
import { formatDate, orDash } from '@/shared/lib/format';
import { RegisterDocumentModal } from './document-modals';
import { OutstandingAcknowledgementsBanner } from './outstanding-banner';
import { VersionHistoryPanel } from './version-panel';
import { DOCUMENT_CATEGORIES, type ControlledDocument } from './document.types';
import { useDocuments, useVersions } from './use-documents';

/**
 * The controlled-document library — ISO 27001 §7.5 and ISO 9001 §7.5 documented information.
 *
 * WHY THIS SCREEN IS THE ONE THE OTHER REGISTERS DEPEND ON. `evidenceDocumentId`, `reportDocumentId` and
 * `minutesDocumentId` all point at rows here: an audit report, a review's minutes, a control's evidence.
 * Until this existed those rows could only be created by an API call, so every one of those references was
 * unreachable from the product.
 *
 * A PUBLISHED VERSION IS IMMUTABLE, and the screen is shaped by that. There is no Edit on anything in force;
 * the only way to change a policy is a new draft, which goes through the approval engine and then supersedes
 * what it replaces. That is what makes "which revision applied on 3 March" answerable at all.
 *
 * THREE PERMISSIONS, NOT ONE. `documents.read` to browse, `documents.manage` to draft and retire,
 * `documents.publish` to put a version in force — and acknowledging needs none, because it records the
 * caller as having read something. The screen mirrors that split rather than gating everything on one code.
 */
export function DocumentsPage() {
  const qc = useQueryClient();
  const list = useListState();
  const { can } = usePermissions();
  const canManage = can('documents.manage');

  const [category, setCategory] = useState('');
  const [includeRetired, setIncludeRetired] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [retiring, setRetiring] = useState<ControlledDocument | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const documents = useDocuments({
    category,
    includeRetired,
    search: list.search,
    limit: list.limit,
    offset: list.offset,
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['documents'] });

  // The drawer's subject, re-read from the page's own list so retiring or publishing moves it. The row
  // carries every field the drawer's header shows; the versions are their own query.
  const selected = selectedId
    ? (documents.data?.data?.find((doc) => doc.id === selectedId) ?? null)
    : null;
  // Read here as well as in the panel: the library row shows WHAT IS IN FORCE, which is a fact about the
  // versions rather than about the document.
  const selectedVersions = useVersions(selectedId);

  function applyFilter(apply: () => void) {
    apply();
    list.resetPaging();
  }

  async function runRetire() {
    if (!retiring) return;
    const { error } = await api.DELETE('/v1/documents/{id}', {
      params: { path: { id: retiring.id } },
    });
    setRetiring(null);
    if (error) {
      toast.error(apiErrorMessage(error, 'Failed to retire the document.'));
      return;
    }
    toast.success('Document retired');
    invalidate();
  }

  const columns: DataTableColumn<ControlledDocument>[] = [
    {
      key: 'code',
      header: 'Code',
      cell: (doc) => <span className="font-mono text-xs font-medium text-fg">{doc.code}</span>,
    },
    {
      key: 'title',
      header: 'Document',
      cell: (doc) => (
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-fg">{doc.title}</p>
          <p className="truncate text-xs text-fg-subtle">{humanizeStatus(doc.category)}</p>
        </div>
      ),
    },
    {
      key: 'owner',
      header: 'Owner',
      // The NAME, not `ownerId`. This column's only job is to say who is accountable for the policy,
      // and thirty-six characters of uuid answered that with nothing.
      cell: (doc) => <span className="text-xs text-fg-muted">{orDash(doc.ownerName)}</span>,
      hideOnMobile: true,
    },
    {
      key: 'status',
      header: 'Status',
      // Retirement is the document's only state — everything else a reader wants to know (which version is
      // in force, when it is due for review) is a fact about a VERSION, and lives in the drawer.
      cell: (doc) =>
        doc.retiredAt ? (
          <StatusBadge tone={statusTone('retired')}>Retired</StatusBadge>
        ) : (
          <StatusBadge tone={statusTone('active')}>Active</StatusBadge>
        ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: (doc) => (
        <RowActions>
          {canManage && !doc.retiredAt && (
            <RowAction tone="danger" onClick={() => setRetiring(doc)}>
              Retire
            </RowAction>
          )}
        </RowActions>
      ),
    },
  ];

  const inForce = (selectedVersions.data ?? []).find(
    (version) => version.status === 'published' && !version.supersededAt,
  );
  /*
   * "Nothing published yet" is a claim about a controlled document, so it must not be what a failed
   * request renders. `selectedVersions.data` is undefined on error exactly as it is before anything
   * has been published, and for a policy library those two facts are not interchangeable: one means
   * the document has no force, the other means we could not tell.
   */
  const inForceLabel = selectedVersions.isError
    ? 'Couldn’t read the revisions'
    : inForce
      ? `v${inForce.version}, published ${formatDate(inForce.publishedAt)}`
      : 'Nothing published yet';

  return (
    <>
      <RegisterDocumentModal
        open={registering}
        onClose={() => setRegistering(false)}
        onSuccess={invalidate}
      />

      {/* Retirement is SOFT and the dialog says so: a superseded control still has to be explainable, so the
          document and its history stay readable with `includeRetired`. */}
      <ConfirmDialog
        open={!!retiring}
        onCancel={() => setRetiring(null)}
        onConfirm={runRetire}
        title="Retire this document?"
        description="It stops appearing in the library and accepts no new revision. Its history stays readable, because a control that cited it still has to be explainable."
        confirmLabel="Retire document"
      />

      <ListPage
        title="Controlled documents"
        description="Policies, procedures and work instructions — what is in force, which revision, and who has acknowledged it."
        actions={
          canManage ? (
            <Button variant="primary" onClick={() => setRegistering(true)}>
              <Plus className="h-4 w-4" strokeWidth={2} />
              Register a document
            </Button>
          ) : undefined
        }
        search={{
          value: list.search,
          onChange: list.setSearch,
          placeholder: 'Search by code or title…',
        }}
        filters={
          <>
            <SegmentedControl
              label="Filter by category"
              options={[
                { value: '', label: 'All' },
                ...DOCUMENT_CATEGORIES.map((code) => ({
                  value: code,
                  label: humanizeStatus(code),
                })),
              ]}
              value={category}
              onChange={(value) => applyFilter(() => setCategory(value))}
            />
            <Button
              variant={includeRetired ? 'primary' : 'outline'}
              size="sm"
              aria-pressed={includeRetired}
              onClick={() => applyFilter(() => setIncludeRetired(!includeRetired))}
            >
              Include retired
            </Button>
          </>
        }
        pageInfo={documents.data?.pageInfo}
        onOffsetChange={list.goToOffset}
        noun="document"
      >
        <div className="mb-4">
          <OutstandingAcknowledgementsBanner onOpenDocument={setSelectedId} />
        </div>

        <DataTable
          columns={columns}
          rows={documents.data?.data}
          isLoading={documents.isLoading}
          isError={documents.isError}
          errorMessage="Failed to load the document library."
          emptyMessage="No documents match these filters"
          emptyIcon={FileText}
          onRowClick={(doc) => setSelectedId(doc.id)}
          isRowActive={(doc) => doc.id === selectedId}
        />
      </ListPage>

      <EntityDetailPanel
        open={!!selectedId}
        onClose={() => setSelectedId(null)}
        title={selected?.title ?? 'Controlled document'}
        description={
          selected ? `${selected.code} · ${humanizeStatus(selected.category)}` : undefined
        }
        headerActions={
          selected && canManage && !selected.retiredAt ? (
            <PanelAction tone="danger" onClick={() => setRetiring(selected)}>
              Retire
            </PanelAction>
          ) : undefined
        }
        items={
          selected
            ? [
                {
                  label: 'Status',
                  value: selected.retiredAt ? (
                    <StatusBadge tone={statusTone('retired')}>Retired</StatusBadge>
                  ) : (
                    <StatusBadge tone={statusTone('active')}>Active</StatusBadge>
                  ),
                },
                {
                  label: 'Category',
                  value: <Badge tone="neutral">{humanizeStatus(selected.category)}</Badge>,
                },
                {
                  label: 'Owner',
                  value: (
                    <span>
                      {orDash(selected.ownerName)}
                      {/* The uuid stays here, secondary: the drawer has room, and it is what somebody
                          quotes in a ticket. */}
                      <span className="ml-2 font-mono text-2xs text-fg-subtle">
                        {selected.ownerId}
                      </span>
                    </span>
                  ),
                },
                {
                  label: 'In force',
                  // The version, not the document: "what is in force" is the first question, and it is
                  // unanswerable from the document row alone.
                  value: inForceLabel,
                },
                {
                  label: 'Review due',
                  value: inForce?.reviewDueOn ? formatDate(inForce.reviewDueOn) : orDash(null),
                },
                { label: 'Registered', value: formatDate(selected.createdAt) },
                ...(selected.retiredAt
                  ? [{ label: 'Retired', value: formatDate(selected.retiredAt) }]
                  : []),
              ]
            : []
        }
        activity={selected ? { resourceId: selected.id, resourceType: 'document' } : undefined}
      >
        {selected && (
          <SlideOverSection title="Revision history">
            <VersionHistoryPanel document={selected} />
          </SlideOverSection>
        )}
      </EntityDetailPanel>
    </>
  );
}
