import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Laptop, Link2, ScanSearch, ShieldAlert, X } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/shared/api/client';
import { apiErrorMessage } from '@/shared/api/errors';
import { assetOptions } from '@/shared/api/picker-sources';
import {
  Badge,
  Button,
  EntityPicker,
  PanelState,
  RowActions,
  Tooltip,
  humanizeStatus,
} from '@/shared/ui';
import { formatDateTime, orDash } from '@/shared/lib/format';
import { classificationTone } from './asset.types';
import { useAssetDevices, useClassificationHistory } from './use-assets';

/**
 * The two things a drawer has to answer about an information asset: how its classification got here, and
 * where the data physically is.
 */

/**
 * Every classification change, oldest first.
 *
 * The audit question is not "what is this classified as" — the row says that — but "when did it become
 * that, and who said so". `fromLevel: null` is the REGISTRATION, which is why it reads as "registered as"
 * rather than showing a dash and leaving somebody to infer it.
 */
export function ClassificationHistoryPanel({ assetId }: { assetId: string }) {
  const history = useClassificationHistory(assetId);
  const rows = history.data ?? [];

  return (
    <div className="flex flex-col gap-2">
      <PanelState
        query={history}
        count={rows.length}
        empty="No changes recorded"
        error="Failed to load the history."
      />

      {rows.map((change) => (
        <div
          key={change.id}
          className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs"
        >
          <div className="flex items-center gap-1.5">
            {change.fromLevel ? (
              <>
                <Badge tone={classificationTone(change.fromLevel)}>
                  {humanizeStatus(change.fromLevel)}
                </Badge>
                <ArrowRight className="h-3 w-3 text-fg-subtle" aria-hidden="true" />
              </>
            ) : (
              <span className="text-fg-subtle">registered as</span>
            )}
            <Badge tone={classificationTone(change.toLevel)}>
              {humanizeStatus(change.toLevel)}
            </Badge>
            <span className="text-fg-subtle">{formatDateTime(change.changedAt)}</span>
          </div>
          <p className="mt-0.5 whitespace-pre-wrap text-fg-muted">{change.reason}</p>
        </div>
      ))}
    </div>
  );
}

/**
 * The devices this asset is held on, and the link itself.
 *
 * WHY THIS PANEL EXISTS. Classifying data answers "how sensitive is it"; this answers "where is it" — and
 * the finding lives in the pair. A restricted dataset on a laptop is not visible from either register
 * alone, which is why the link exists at all and why the count is on the list row too.
 *
 * LINKING IS A `PUT` ON THE PAIR, like `PUT /risks/:id/controls/:controlId` and for the same reason: the
 * two ids ARE the fact, so the route is idempotent and linking twice is still one link. Nothing here has to
 * check whether the link already exists.
 *
 * A RETIRED ASSET TAKES NO NEW LINKS BUT WILL STILL GIVE ONE UP, and that asymmetry is the API's, not a
 * choice made here: `InformationAssetService.linkDevice` asserts the asset is not retired, `unlinkDevice`
 * does not. Retirement freezes what the asset holds as historical evidence; correcting a link that was
 * always wrong is a different act. So the picker goes away and the unlink buttons stay.
 */
export function AssetDevicesPanel({
  assetId,
  encryptionRequired,
  canManage,
  retired,
  onInspectDevice,
}: {
  assetId: string;
  /** From the classification level, so the warning below states policy rather than opinion. */
  encryptionRequired: boolean;
  canManage: boolean;
  /** Set when the asset is retired — the API refuses a new link, so the screen does not offer one. */
  retired: boolean;
  /** Opens the lost-laptop report for one device. Owned by the page: the report is a modal. */
  onInspectDevice: (deviceAssetId: string, assetTag: string) => void;
}) {
  const qc = useQueryClient();
  const devices = useAssetDevices(assetId);
  const [linking, setLinking] = useState('');
  const rows = devices.data ?? [];

  // One key for the whole register: a link moves the device list, the row's `deviceCount` and the
  // holdings report, which are three views of one write.
  const invalidate = () => qc.invalidateQueries({ queryKey: ['information-assets'] });

  async function link(deviceAssetId: string) {
    const { error } = await api.PUT('/v1/information-assets/{id}/devices/{deviceAssetId}', {
      params: { path: { id: assetId, deviceAssetId } },
    });
    setLinking('');
    if (error) {
      toast.error(apiErrorMessage(error, 'Failed to record the device.'));
      return;
    }
    toast.success('Device linked');
    invalidate();
  }

  async function unlink(deviceAssetId: string, assetTag: string) {
    const { error } = await api.DELETE('/v1/information-assets/{id}/devices/{deviceAssetId}', {
      params: { path: { id: assetId, deviceAssetId } },
    });
    if (error) {
      toast.error(apiErrorMessage(error, 'Failed to remove the device.'));
      return;
    }
    toast.success(`${assetTag} unlinked`);
    invalidate();
  }

  return (
    <div className="flex flex-col gap-2">
      <PanelState
        query={devices}
        count={rows.length}
        empty="Not held on any registered device"
        error="Failed to load the devices."
      />

      {/* Stated once, above the list, when the level demands encryption: every device below is then a
          place that claim has to be true. */}
      {rows.length > 0 && encryptionRequired && (
        <p className="flex items-start gap-1.5 text-xs text-warning">
          <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={2} />
          This classification requires encryption, so each device below has to be encrypted at rest.
        </p>
      )}

      {rows.map((device) => (
        <div
          key={device.deviceAssetId}
          className="flex items-center gap-2 rounded-md border border-border bg-surface px-2.5 py-1.5"
        >
          <Laptop className="h-4 w-4 shrink-0 text-fg-subtle" strokeWidth={1.75} />
          <div className="min-w-0 flex-1">
            <p className="truncate font-mono text-xs font-medium text-fg">{device.assetTag}</p>
            <p className="truncate text-xs text-fg-subtle">
              {humanizeStatus(device.type)} · {humanizeStatus(device.status)}
            </p>
          </div>
          {/* An unassigned device holding classified data is its own question, so the absence is named. */}
          <span className="shrink-0 text-xs text-fg-subtle">
            {device.assignedTo ? orDash(device.assignedTo) : 'Unassigned'}
          </span>
          <RowActions>
            {/* The link read backwards, from the row that names the device: what ELSE is on this
                machine. Available to anybody who can read the register — it is a report, not a change. */}
            <Tooltip content="What this device holds">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`What ${device.assetTag} holds`}
                onClick={() => onInspectDevice(device.deviceAssetId, device.assetTag)}
              >
                <ScanSearch className="h-3.5 w-3.5" strokeWidth={2} />
              </Button>
            </Tooltip>
            {canManage && (
              <Tooltip content="Unlink">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Unlink ${device.assetTag}`}
                  onClick={() => void unlink(device.deviceAssetId, device.assetTag)}
                >
                  <X className="h-3.5 w-3.5" strokeWidth={2} />
                </Button>
              </Tooltip>
            )}
          </RowActions>
        </div>
      ))}

      {canManage && retired && (
        <p className="text-xs text-fg-subtle">
          Retired, so no new device can be recorded — what it held is now historical evidence.
        </p>
      )}

      {canManage && !retired && (
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <EntityPicker
              ariaLabel="Device to link"
              queryKey="assets"
              value={linking}
              onChange={(value) => {
                setLinking(value);
                if (value) void link(value);
              }}
              fetchOptions={assetOptions}
              placeholder="Link a device…"
            />
          </div>
          <Link2
            className="h-4 w-4 shrink-0 text-fg-subtle"
            strokeWidth={1.75}
            aria-hidden="true"
          />
        </div>
      )}
    </div>
  );
}
