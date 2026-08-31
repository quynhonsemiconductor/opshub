import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Laptop, Plus } from 'lucide-react';
import {
  Button,
  ConfirmDialog,
  DataTable,
  EntityDetailPanel,
  ListPage,
  FileUploadWidget,
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
import { useAssetPhotoUrl } from '@/shared/api/attachment-urls';
import { useListState } from '@/shared/hooks/use-list-state';
import { usePermissions } from '@/shared/hooks/use-permissions';
import { EM_DASH, formatDate, orDash } from '@/shared/lib/format';
import { AddAssetModal } from './add-asset-modal';
import { AssignAssetModal, AssignmentHistoryPanel } from './asset-lifecycle';
import { ASSET_NEXT_ACTIONS, ASSET_STATUS_FILTERS, type Asset } from './asset.types';
import { useAssetTransition, useAssets } from './use-assets';

/*
 * WHAT THIS SCREEN NO LONGER CARRIES
 *
 * A `STATUS_LABEL` and a `STATUS_CLASS` map — the second of which coloured `in_stock` with the accent
 * tone while every other screen used it for "informational", and `assigned` green as though being
 * assigned were a success rather than a state. Both now come from `statusTone`/`humanizeStatus`. Plus a
 * hand-rolled dialog, an `inputClass`, five raw header cells, a `dl` grid, an inline search box, and
 * `limit: 50` with no paging.
 */

/**
 * The hardware register, and the custody chain over it.
 *
 * THE LIFECYCLE IS THE POINT OF AN INVENTORY. Listing what exists is the easy half; the half that answers
 * "who had this laptop when the data on it leaked" is the assignment history, and until now none of it was
 * reachable from the product — assign, unassign, retire and the history were API-only.
 *
 * TWO PERMISSIONS, MIRRORED. Handing an asset over and taking it back are `asset.reassign`; creating and
 * retiring are `asset.write`. Custody and existence are different decisions, and the API separates them.
 *
 * NO ACTION IS OFFERED THAT THE API WOULD ONLY REFUSE — `ASSET_NEXT_ACTIONS` mirrors the service, so a
 * retired asset offers nothing, and an assigned one offers a return rather than a retirement it would refuse
 * until the hardware is back.
 */
export function AssetsPage() {
  const qc = useQueryClient();
  const { can } = usePermissions();
  const canReassign = can('asset.reassign');
  const canWrite = can('asset.write');

  const [showAdd, setShowAdd] = useState(false);
  const [status, setStatus] = useState('');
  const [assigning, setAssigning] = useState<Asset | null>(null);
  const [confirming, setConfirming] = useState<{
    asset: Asset;
    action: 'unassign' | 'retire';
  } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const list = useListState();

  const assets = useAssets({
    status,
    type: '',
    search: list.search,
    limit: list.limit,
    offset: list.offset,
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['assets'] });
  const transition = useAssetTransition(() => setConfirming(null));

  // Re-read from the page's own list, so assigning or retiring moves the drawer with the row.
  const selected = selectedId
    ? (assets.data?.data?.find((asset) => asset.id === selectedId) ?? null)
    : null;

  /*
   * THE PHOTO ALREADY ON THE RECORD, re-read whenever a row is opened.
   *
   * Nothing fetched this before, so the widget was handed a `null` that only ever became non-null from the
   * confirm response — and that response was being misread, so it stayed null too. The upload worked; the
   * screen just never showed it again.
   */
  const photo = useAssetPhotoUrl(selectedId);

  function applyFilter(apply: () => void) {
    apply();
    list.resetPaging();
  }

  const columns: DataTableColumn<Asset>[] = [
    {
      key: 'tag',
      header: 'Tag',
      cell: (a) => <span className="font-mono text-xs font-medium text-fg">{a.assetTag}</span>,
    },
    { key: 'type', header: 'Type', cell: (a) => humanizeStatus(a.type) },
    {
      key: 'model',
      header: 'Model',
      cell: (a) => [a.manufacturer, a.model].filter(Boolean).join(' ') || EM_DASH,
      hideOnMobile: true,
    },
    {
      key: 'status',
      header: 'Status',
      cell: (a) => (
        <StatusBadge tone={statusTone(a.status)}>{humanizeStatus(a.status)}</StatusBadge>
      ),
    },
    {
      key: 'assignedTo',
      header: 'Assigned to',
      cell: (a) => orDash(a.assignedTo),
      hideOnMobile: true,
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: (asset) => {
        const steps = ASSET_NEXT_ACTIONS[asset.status] ?? [];
        return (
          <RowActions>
            {canReassign && steps.includes('assign') && (
              <RowAction tone="accent" onClick={() => setAssigning(asset)}>
                Assign
              </RowAction>
            )}
            {canReassign && steps.includes('unassign') && (
              <RowAction onClick={() => setConfirming({ asset, action: 'unassign' })}>
                Return
              </RowAction>
            )}
            {/* Withheld while the asset is out: the service refuses to retire an assigned one, because
                retiring it in place leaves the holder responsible for something the register says is gone. */}
            {canWrite && steps.includes('retire') && (
              <RowAction tone="danger" onClick={() => setConfirming({ asset, action: 'retire' })}>
                Retire
              </RowAction>
            )}
          </RowActions>
        );
      },
    },
  ];

  return (
    <>
      <AddAssetModal open={showAdd} onClose={() => setShowAdd(false)} onSuccess={invalidate} />
      {assigning && (
        <AssignAssetModal
          asset={assigning}
          onClose={() => setAssigning(null)}
          onSuccess={invalidate}
        />
      )}

      {/* Both transitions take no input, so a confirmation rather than a form — and each dialog carries the
          consequence, which is the part somebody needs before clicking. */}
      <ConfirmDialog
        open={!!confirming}
        onCancel={() => setConfirming(null)}
        onConfirm={() => confirming && transition.mutate(confirming)}
        title={
          confirming?.action === 'unassign' ? 'Return this asset to stock?' : 'Retire this asset?'
        }
        description={
          confirming?.action === 'unassign'
            ? 'Closes the open custody row with today as the return date. The assignment stays on the history.'
            : 'Takes it out of the assignable pool for good. Its history stays, because who held it is still the answer to a later question.'
        }
        confirmLabel={confirming?.action === 'unassign' ? 'Return to stock' : 'Retire asset'}
      />

      <ListPage
        title="Assets"
        description="The hardware inventory: what exists, what state it is in, and who holds it."
        actions={
          <Button variant="primary" onClick={() => setShowAdd(true)}>
            <Plus className="h-4 w-4" strokeWidth={2} />
            Add asset
          </Button>
        }
        search={{
          value: list.search,
          onChange: list.setSearch,
          placeholder: 'Search tag, model or serial…',
        }}
        filters={
          <SegmentedControl
            label="Filter by status"
            options={ASSET_STATUS_FILTERS.map((option) => ({ ...option }))}
            value={status}
            onChange={(value) => applyFilter(() => setStatus(value))}
          />
        }
        pageInfo={assets.data?.pageInfo}
        onOffsetChange={list.goToOffset}
        noun="assets"
      >
        <DataTable
          columns={columns}
          rows={assets.data?.data}
          isLoading={assets.isLoading}
          isError={assets.isError}
          errorMessage="Failed to load assets."
          emptyMessage={list.search ? 'No assets match that search' : 'No assets yet'}
          emptyIcon={Laptop}
          emptyAction={
            list.search ? undefined : (
              <Button variant="primary" size="sm" onClick={() => setShowAdd(true)}>
                <Plus className="h-3.5 w-3.5" /> Add asset
              </Button>
            )
          }
          onRowClick={(a) => setSelectedId(a.id)}
          isRowActive={(a) => a.id === selectedId}
        />
      </ListPage>

      <EntityDetailPanel
        open={!!selectedId}
        onClose={() => setSelectedId(null)}
        title={selected?.assetTag ?? 'Asset detail'}
        description={
          selected ? [selected.manufacturer, selected.model].filter(Boolean).join(' ') : undefined
        }
        items={
          selected
            ? [
                {
                  label: 'Tag',
                  value: <span className="font-mono text-xs">{selected.assetTag}</span>,
                },
                { label: 'Type', value: humanizeStatus(selected.type) },
                { label: 'Model', value: selected.model },
                { label: 'Serial', value: selected.serialNumber },
                {
                  label: 'Status',
                  value: (
                    <StatusBadge tone={statusTone(selected.status)}>
                      {humanizeStatus(selected.status)}
                    </StatusBadge>
                  ),
                },
                { label: 'Assigned to', value: selected.assignedTo },
                // Purchase and warranty dates are ON the response and were never shown — the drawer
                // had a `notes` row instead, for a field the response does not carry.
                { label: 'Purchased', value: formatDate(selected.purchaseDate) },
                { label: 'Warranty ends', value: formatDate(selected.warrantyExpiry) },
              ]
            : []
        }
        headerActions={
          selected &&
          canReassign &&
          (ASSET_NEXT_ACTIONS[selected.status] ?? []).includes('assign') ? (
            <PanelAction tone="accent" onClick={() => setAssigning(selected)}>
              Assign
            </PanelAction>
          ) : selected &&
            canReassign &&
            (ASSET_NEXT_ACTIONS[selected.status] ?? []).includes('unassign') ? (
            <PanelAction onClick={() => setConfirming({ asset: selected, action: 'unassign' })}>
              Return to stock
            </PanelAction>
          ) : undefined
        }
        activity={selected ? { resourceId: selected.id, resourceType: 'asset' } : undefined}
      >
        {selected && (
          <SlideOverSection title="Custody history">
            <AssignmentHistoryPanel assetId={selected.id} />
          </SlideOverSection>
        )}
        {selected && (
          <SlideOverSection title="Photo">
            <FileUploadWidget
              mode="image"
              currentUrl={photo.data}
              presignUrl={`/v1/assets/${selected.id}/photo/presign`}
              confirmUrl={`/v1/assets/${selected.id}/photo/confirm`}
              accept="image/jpeg,image/png,image/webp"
              // ONE SOURCE OF TRUTH: refetch and let the readback answer. The widget already shows a local
              // preview of the file just chosen, so a copy of the URL in page state would only be a second
              // thing that could disagree with the server.
              onSuccess={() => {
                void qc.invalidateQueries({ queryKey: ['attachment-url', 'asset-photo'] });
                invalidate();
              }}
              label="Asset photo (JPEG, PNG, WebP · max 5 MB)"
            />
          </SlideOverSection>
        )}
      </EntityDetailPanel>
    </>
  );
}
