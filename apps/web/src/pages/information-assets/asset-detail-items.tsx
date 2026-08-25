import { Badge, humanizeStatus, type DescriptionItem } from '@/shared/ui';
import { formatDate, orDash } from '@/shared/lib/format';
import { classificationTone, type ClassificationLevel, type InformationAsset } from './asset.types';

/**
 * The rows of an information asset's detail drawer.
 *
 * EXTRACTED rather than inlined in the page, because the page hit the 486-line ceiling the FE
 * consistency ratchet enforces — and that ratchet's message is the right instruction: a page is
 * composition, and a ninety-line literal describing one panel is not composition. Nothing about the
 * rows changed in the move.
 *
 * A function returning `DescriptionItem[]` rather than a component: `EntityDetailPanel` takes `items`,
 * so a component here would have to be rendered into a prop, which React cannot do.
 */
export function assetDetailItems(
  asset: InformationAsset,
  levelFor: (code: string) => ClassificationLevel | undefined,
): DescriptionItem[] {
  return [
    {
      label: 'Classification',
      value: (
        <Badge tone={classificationTone(asset.classification)}>
          {humanizeStatus(asset.classification)}
        </Badge>
      ),
    },
    {
      label: 'Handling',
      wide: true,
      // The policy's own words, from the reference table.
      value: orDash(levelFor(asset.classification)?.handlingRules),
    },
    { label: 'Type', value: humanizeStatus(asset.type) },
    {
      label: 'Owner',
      value: (
        <span>
          {orDash(asset.ownerName)}
          {/* The uuid stays here, secondary: the drawer has room, and it is what somebody quotes in
              a ticket. */}
          <span className="ml-2 font-mono text-2xs text-fg-subtle">{asset.ownerId}</span>
        </span>
      ),
    },
    {
      label: 'Custodian',
      /*
       * "Same as owner" is kept for the ABSENT custodian, which is a different fact from a custodian
       * whose name will not resolve — and this row sits directly under the Owner one, so a uuid here
       * while the owner reads as a name looked like an oversight rather than a decision.
       */
      value: asset.custodianId ? (
        <span>
          {orDash(asset.custodianName)}
          <span className="ml-2 font-mono text-2xs text-fg-subtle">{asset.custodianId}</span>
        </span>
      ) : (
        'Same as owner'
      ),
    },
    {
      label: 'C·I·A',
      value: `${asset.confidentiality} · ${asset.integrity} · ${asset.availability}`,
    },
    { label: 'Personal data', value: asset.personalData ? 'Yes' : 'No' },
    { label: 'Location', value: orDash(asset.location) },
    {
      label: 'Retention',
      value: asset.retentionMonths ? `${asset.retentionMonths} months` : 'Not recorded',
    },
    { label: 'Last reviewed', value: formatDate(asset.lastReviewedAt) },
    { label: 'Review due', value: formatDate(asset.reviewDueOn) },
    // Only when it happened: a "Retired: —" row on every live asset says nothing.
    ...(asset.retiredAt ? [{ label: 'Retired', value: formatDate(asset.retiredAt) }] : []),
    ...(asset.description ? [{ label: 'Description', wide: true, value: asset.description }] : []),
  ];
}
