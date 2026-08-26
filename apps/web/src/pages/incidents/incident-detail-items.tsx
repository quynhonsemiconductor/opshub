import { Badge, StatusBadge, humanizeStatus, statusTone, type DescriptionItem } from '@/shared/ui';
import { formatDateTime, orDash } from '@/shared/lib/format';
import type { Incident } from './incident.types';

/**
 * The rows of an incident's detail drawer.
 *
 * EXTRACTED because the page crossed the 486-line ceiling the FE consistency ratchet holds, and that
 * ratchet's instruction is the right one: a page is composition, and an eighty-line literal describing
 * one panel is a component. Nothing about the rows changed in the move.
 */
export function incidentDetailItems(selected: Incident): DescriptionItem[] {
  return [
    {
      label: 'Status',
      value: (
        <StatusBadge tone={statusTone(selected.status)}>
          {humanizeStatus(selected.status)}
        </StatusBadge>
      ),
    },
    {
      label: 'Severity',
      value: (
        <Badge tone={statusTone(selected.severity)}>{humanizeStatus(selected.severity)}</Badge>
      ),
    },
    { label: 'Category', value: selected.category },
    { label: 'Detected', value: formatDateTime(selected.detectedAt) },
    {
      label: 'Reported by',
      value: <span className="font-mono text-xs">{selected.reportedBy}</span>,
    },
    {
      label: 'Owner',
      value: selected.assignedTo ? (
        <span className="font-mono text-xs">{selected.assignedTo}</span>
      ) : (
        'Unassigned'
      ),
    },
    { label: 'Contained', value: formatDateTime(selected.containedAt) },
    { label: 'Resolved', value: formatDateTime(selected.resolvedAt) },
    { label: 'Closed', value: formatDateTime(selected.closedAt) },
    {
      label: 'Personal data breach',
      value: selected.personalDataBreach
        ? selected.regulatorNotifiedAt
          ? `Regulator notified ${formatDateTime(selected.regulatorNotifiedAt)}`
          : `Notification due ${formatDateTime(selected.notificationDueAt)}`
        : 'No',
    },
    {
      label: 'What happened',
      wide: true,
      value: <p className="whitespace-pre-wrap text-sm text-fg-muted">{selected.description}</p>,
    },
    // Only once they exist: an empty "root cause" on a live incident reads as an incident
    // nobody investigated.
    ...(selected.rootCause ? [{ label: 'Root cause', wide: true, value: selected.rootCause }] : []),
    ...(selected.lessonsLearned
      ? [{ label: 'Lessons learned', wide: true, value: selected.lessonsLearned }]
      : []),
    ...(selected.riskId
      ? [
          {
            label: 'Linked risk',
            value: <span className="font-mono text-xs">{selected.riskId}</span>,
          },
        ]
      : [{ label: 'Linked risk', value: orDash(null) }]),
    // Shown for the same reason as the risk, and always rather than only when set: both are
    // settable from the correction form now, and a field somebody can fill in and never see
    // again is a field nobody trusts they filled in.
    ...(selected.assetId
      ? [
          {
            label: 'Affected device',
            value: <span className="font-mono text-xs">{selected.assetId}</span>,
          },
        ]
      : [{ label: 'Affected device', value: orDash(null) }]),
  ];
}
