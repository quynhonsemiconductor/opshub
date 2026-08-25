import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Database, Plus, ScanSearch } from 'lucide-react';
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
  StatCard,
  StatGrid,
  humanizeStatus,
  type DataTableColumn,
} from '@/shared/ui';
import { useListState } from '@/shared/hooks/use-list-state';
import { usePermissions } from '@/shared/hooks/use-permissions';
import { formatDate, orDash } from '@/shared/lib/format';
import { RegisterAssetModal, ReclassifyAssetModal } from './asset-modals';
import { AssetDevicesPanel, ClassificationHistoryPanel } from './asset-panels';
import { DeviceHoldingsModal } from './device-holdings-modal';
import { CLASSIFICATION_FILTERS, classificationTone } from './asset.types';
import {
  useClassificationLevels,
  useClassificationSummary,
  useInformationAssets,
} from './use-assets';
import type { InformationAsset } from './asset.types';

/**
 * The information-asset register: what data exists, how sensitive it is, who owns it, and where it lives.
 *
 * CLASSIFICATION IS A DECISION WITH A HISTORY, not a field. Every change carries a reason and appends a
 * row, so the register answers "when did this become restricted and who said so" — and LOWERING a
 * classification is a different permission (`information_asset.declassify`) because it takes protection
 * away. The screen routes to the endpoint that matches the direction rather than asking the user which.
 *
 * THE THREE CIA RATINGS STAY SEPARATE. A public dataset can still be availability-critical; a single
 * combined score would throw that away, and the API keeps them apart for the same reason.
 *
 * THE DEVICE COUNT IS ON THE ROW because "how sensitive" and "where is it" are only useful together — a
 * restricted dataset on three laptops is the finding, and it is invisible from either register alone.
 *
 * RETIREMENT IS THE END OF CHANGES, NOT OF THE ROW. A retired asset keeps its history and its device links
 * because a risk assessment and an incident from last year point at it, and the API refuses every further
 * edit. So the screen stops offering those edits rather than letting them fail, and it can show the retired
 * rows on request — otherwise retiring looks exactly like deleting.
 */
export function InformationAssetsPage() {
  const qc = useQueryClient();
  const list = useListState();
  const { can } = usePermissions();
  const canManage = can('information_asset.manage');
  const canDeclassify = can('information_asset.declassify');

  const [classification, setClassification] = useState('');
  const [personalDataOnly, setPersonalDataOnly] = useState(false);
  const [includeRetired, setIncludeRetired] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [reclassifying, setReclassifying] = useState<InformationAsset | null>(null);
  const [reviewing, setReviewing] = useState<InformationAsset | null>(null);
  const [retiring, setRetiring] = useState<InformationAsset | null>(null);
  /** The lost-laptop report. `''` for a device not chosen yet — the modal offers the picker. */
  const [inspecting, setInspecting] = useState<{ id: string; label: string } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const assets = useInformationAssets({
    classification,
    type: '',
    personalDataOnly,
    includeRetired,
    search: list.search,
    limit: list.limit,
    offset: list.offset,
  });
  const summary = useClassificationSummary();
  const levels = useClassificationLevels();
  const invalidate = () => qc.invalidateQueries({ queryKey: ['information-assets'] });

  /**
   * The open asset, READ BACK OUT OF THE LIST rather than held as a copy.
   *
   * `deviceCount` is on the row, and linking a device from inside the drawer changes it. A snapshot taken
   * when the row was clicked would keep showing the old number in the section heading directly above the
   * device that had just been added.
   */
  const selected = selectedId
    ? (assets.data?.data?.find((asset) => asset.id === selectedId) ?? null)
    : null;

  const levelFor = (code: string) => levels.data?.find((level) => level.code === code);

  async function markReviewed() {
    if (!reviewing) return;
    const { error } = await api.POST('/v1/information-assets/{id}/reviewed', {
      params: { path: { id: reviewing.id } },
      // No next date: the API keeps the asset's existing schedule rather than having this button
      // silently rewrite it.
      body: {},
    });
    setReviewing(null);
    if (error) {
      toast.error(apiErrorMessage(error, 'Failed to record the review.'));
      return;
    }
    toast.success('Review recorded');
    invalidate();
  }

  async function retire() {
    if (!retiring) return;
    const { error } = await api.POST('/v1/information-assets/{id}/retire', {
      params: { path: { id: retiring.id } },
    });
    setRetiring(null);
    if (error) {
      toast.error(apiErrorMessage(error, 'Failed to retire the asset.'));
      return;
    }
    toast.success('Information asset retired');
    /*
     * CLOSED EXPLICITLY, not left to fall out of the derivation. `selected` is read back out of the list, so
     * the drawer does go when the retired row leaves it — and then CAME BACK the moment somebody turned on
     * "Include retired", because the id was still held. A drawer reopening on a filter change is a
     * surprise, and its backdrop swallows the click that caused it.
     */
    setSelectedId(null);
    invalidate();
  }

  function applyFilter(apply: () => void) {
    apply();
    list.resetPaging();
  }

  const columns: DataTableColumn<InformationAsset>[] = [
    {
      key: 'reference',
      header: 'Reference',
      cell: (asset) => (
        <span className="font-mono text-xs font-medium text-fg">{asset.reference}</span>
      ),
    },
    {
      key: 'name',
      header: 'Asset',
      cell: (asset) => (
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <p className="truncate text-sm font-medium text-fg">{asset.name}</p>
            {/* Only visible with the retired filter on, and the reason the filter exists: a retired row
                that looked like a live one would be read as part of the current inventory. */}
            {asset.retiredAt && <Badge>Retired</Badge>}
          </div>
          <p className="truncate text-xs text-fg-subtle">{humanizeStatus(asset.type)}</p>
        </div>
      ),
    },
    {
      key: 'classification',
      header: 'Classification',
      cell: (asset) => (
        <div className="flex items-center gap-1.5">
          <Badge tone={classificationTone(asset.classification)}>
            {humanizeStatus(asset.classification)}
          </Badge>
          {/* From the level, not from the asset: encryption is a property of the classification. */}
          {asset.encryptionRequired && <span className="text-xs text-warning">encrypted</span>}
        </div>
      ),
    },
    {
      key: 'cia',
      header: 'C·I·A',
      align: 'right',
      cell: (asset) => (
        <span className="tabular-nums text-xs text-fg-muted">
          {asset.confidentiality}·{asset.integrity}·{asset.availability}
        </span>
      ),
      hideOnMobile: true,
    },
    {
      key: 'personalData',
      header: 'Personal data',
      cell: (asset) =>
        asset.personalData ? (
          <Badge tone="amber">Yes</Badge>
        ) : (
          <span className="text-xs text-fg-subtle">No</span>
        ),
    },
    {
      key: 'devices',
      header: 'Devices',
      align: 'right',
      // Zero is meaningful — nothing registered holds it — so it is a number, not a dash.
      cell: (asset) => <span className="tabular-nums">{asset.deviceCount}</span>,
      hideOnMobile: true,
    },
    {
      key: 'review',
      header: 'Review due',
      cell: (asset) => formatDate(asset.reviewDueOn),
      hideOnMobile: true,
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      // A RETIRED ASSET OFFERS NOTHING. The API refuses a re-rating, a reclassification and a new device
      // link on one, so an action here could only ever produce a 412 explaining that.
      cell: (asset) =>
        asset.retiredAt ? null : (
          <RowActions>
            {(canManage || canDeclassify) && (
              <RowAction tone="accent" onClick={() => setReclassifying(asset)}>
                Reclassify
              </RowAction>
            )}
            {canManage && (
              <RowAction tone="success" onClick={() => setReviewing(asset)}>
                Reviewed
              </RowAction>
            )}
          </RowActions>
        ),
    },
  ];

  return (
    <>
      <RegisterAssetModal
        open={registering}
        onClose={() => setRegistering(false)}
        onSuccess={invalidate}
      />
      {reclassifying && (
        <ReclassifyAssetModal
          asset={reclassifying}
          onClose={() => setReclassifying(null)}
          onSuccess={invalidate}
        />
      )}
      {/* AT PAGE LEVEL, not inside the drawer that opens it: a dialog rendered by the drawer's own subtree
          dies with it, and the drawer closes when the list it reads from stops containing the row. */}
      {inspecting && (
        <DeviceHoldingsModal
          deviceAssetId={inspecting.id}
          deviceLabel={inspecting.label}
          onClose={() => setInspecting(null)}
        />
      )}

      <ConfirmDialog
        open={!!reviewing}
        onCancel={() => setReviewing(null)}
        onConfirm={markReviewed}
        title="Record a review of this asset?"
        description="Stamps today as the last review. The next due date stays as it is — changing the schedule is an edit, not a review."
        confirmLabel="Record review"
      />

      {/* THE API'S OWN RULES, SAID BEFORE THE ACT rather than restated as a 412 afterwards. Retirement is
          not a delete and not reversible through this screen: the row, its classification history and its
          device links all survive, and nothing further can be changed. */}
      <ConfirmDialog
        open={!!retiring}
        variant="danger"
        onCancel={() => setRetiring(null)}
        onConfirm={retire}
        title={`Retire ${retiring?.reference ?? 'this asset'}?`}
        description="The entry stays, with its classification history and its device links — a risk assessment or an incident may still point at it. It then accepts no further changes: no re-rating, no reclassification, no new device. There is no un-retire here."
        confirmLabel="Retire asset"
      />

      <ListPage
        title="Information assets"
        description="What data the organisation holds, how sensitive it is, who owns it, and which devices hold it."
        actions={
          <>
            {/* The register read backwards. Not behind `manage`: it is a report, and the person asking
                "what was on that laptop" during an incident is often not the one who maintains the
                register. */}
            <Button variant="outline" onClick={() => setInspecting({ id: '', label: '' })}>
              <ScanSearch className="h-4 w-4" strokeWidth={2} />
              What a device holds
            </Button>
            {canManage && (
              <Button variant="primary" onClick={() => setRegistering(true)}>
                <Plus className="h-4 w-4" strokeWidth={2} />
                Register an asset
              </Button>
            )}
          </>
        }
        search={{
          value: list.search,
          onChange: list.setSearch,
          placeholder: 'Search assets…',
        }}
        filters={
          <>
            <SegmentedControl
              label="Filter by classification"
              options={CLASSIFICATION_FILTERS.map((option) => ({ ...option }))}
              value={classification}
              onChange={(value) => applyFilter(() => setClassification(value))}
            />
            <Button
              variant={personalDataOnly ? 'primary' : 'outline'}
              size="sm"
              aria-pressed={personalDataOnly}
              onClick={() => applyFilter(() => setPersonalDataOnly(!personalDataOnly))}
            >
              Personal data only
            </Button>
            {/* The register means the CURRENT inventory, so retired rows are out by default — but
                reachable, because otherwise retiring an asset is indistinguishable from deleting it. */}
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
        pageInfo={assets.data?.pageInfo}
        onOffsetChange={list.goToOffset}
        noun="asset"
      >
        {/* The register's shape at a glance, and it is the report an audit opens with: how much sits at
            each level, and how much of THAT is personal data or on a device. */}
        <StatGrid>
          {(summary.data ?? [])
            .slice()
            .sort((a, b) => b.rank - a.rank)
            .map((row) => (
              <StatCard
                key={row.classification}
                label={humanizeStatus(row.classification)}
                value={row.assets}
                hint={`${row.personalDataAssets} personal data · ${row.onDevices} on devices`}
                tone={classificationTone(row.classification)}
                loading={summary.isLoading}
              />
            ))}
        </StatGrid>

        <div className="mt-4">
          <DataTable
            columns={columns}
            rows={assets.data?.data}
            isLoading={assets.isLoading}
            isError={assets.isError}
            errorMessage="Failed to load the information-asset register."
            emptyMessage="No assets match these filters"
            emptyIcon={Database}
            onRowClick={(asset) => setSelectedId(asset.id)}
            isRowActive={(asset) => asset.id === selectedId}
          />
        </div>
      </ListPage>

      <EntityDetailPanel
        open={!!selected}
        onClose={() => setSelectedId(null)}
        title={selected?.name ?? 'Information asset'}
        description={selected?.reference}
        headerActions={
          selected && !selected.retiredAt ? (
            <>
              {(canManage || canDeclassify) && (
                <PanelAction tone="accent" onClick={() => setReclassifying(selected)}>
                  Reclassify
                </PanelAction>
              )}
              {/* Retiring lives HERE and not in the row, because it is the one act on this screen that
                  cannot be undone — and the drawer is where somebody has actually read the entry. */}
              {canManage && (
                <PanelAction tone="danger" onClick={() => setRetiring(selected)}>
                  Retire
                </PanelAction>
              )}
            </>
          ) : undefined
        }
        items={
          selected
            ? [
                {
                  label: 'Classification',
                  value: (
                    <Badge tone={classificationTone(selected.classification)}>
                      {humanizeStatus(selected.classification)}
                    </Badge>
                  ),
                },
                {
                  label: 'Handling',
                  wide: true,
                  // The policy's own words, from the reference table.
                  value: orDash(levelFor(selected.classification)?.handlingRules),
                },
                { label: 'Type', value: humanizeStatus(selected.type) },
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
                  label: 'Custodian',
                  value: selected.custodianId ? (
                    <span className="font-mono text-xs">{selected.custodianId}</span>
                  ) : (
                    'Same as owner'
                  ),
                },
                {
                  label: 'C·I·A',
                  value: `${selected.confidentiality} · ${selected.integrity} · ${selected.availability}`,
                },
                { label: 'Personal data', value: selected.personalData ? 'Yes' : 'No' },
                { label: 'Location', value: orDash(selected.location) },
                {
                  label: 'Retention',
                  value: selected.retentionMonths
                    ? `${selected.retentionMonths} months`
                    : 'Not recorded',
                },
                { label: 'Last reviewed', value: formatDate(selected.lastReviewedAt) },
                { label: 'Review due', value: formatDate(selected.reviewDueOn) },
                // Only when it happened: a "Retired: —" row on every live asset says nothing.
                ...(selected.retiredAt
                  ? [{ label: 'Retired', value: formatDate(selected.retiredAt) }]
                  : []),
                ...(selected.description
                  ? [{ label: 'Description', wide: true, value: selected.description }]
                  : []),
              ]
            : []
        }
        activity={
          selected ? { resourceId: selected.id, resourceType: 'information_asset' } : undefined
        }
      >
        {selected && (
          <>
            <SlideOverSection title="Classification history">
              <ClassificationHistoryPanel assetId={selected.id} />
            </SlideOverSection>
            <SlideOverSection title={`Devices (${selected.deviceCount})`}>
              <AssetDevicesPanel
                assetId={selected.id}
                encryptionRequired={selected.encryptionRequired}
                canManage={canManage}
                retired={!!selected.retiredAt}
                onInspectDevice={(id, label) => setInspecting({ id, label })}
              />
            </SlideOverSection>
          </>
        )}
      </EntityDetailPanel>
    </>
  );
}
