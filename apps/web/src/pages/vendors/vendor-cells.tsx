import { Badge, Tooltip, humanizeStatus } from '@/shared/ui';
import { formatDate } from '@/shared/lib/format';
import { outcomeTone, type Vendor } from './vendor.types';

/**
 * The register's cells that are more than a formatted value.
 *
 * Out of `vendors-page.tsx` because a page is composition — the file-length ceiling in the FE ratchets
 * exists to keep it that way — and because both of these say something rather than just print a field.
 */

/**
 * The PROCESSOR cell of the supplier register — and the one finding on this screen that acts.
 *
 * A processor with no data processing agreement is its own finding, so the two facts sit in one column
 * rather than in separate ones nobody reads across: "yes, they handle personal data for us" is only
 * interesting alongside "and there is nothing in writing about it".
 */
export function ProcessorCell({
  vendor,
  /**
   * Open the correction form on the agreement picker. Omitted when there is nothing to open — no
   * `vendor.manage`, or a terminated supplier whose record `VendorService.update` refuses outright —
   * and the badge then falls back to a plain label.
   */
  onRecordAgreement,
}: {
  vendor: Vendor;
  onRecordAgreement?: () => void;
}) {
  if (!vendor.dataProcessor) return <span className="text-xs text-fg-subtle">No</span>;
  if (vendor.dataProcessingAgreementId) return <Badge tone="green">DPA on file</Badge>;

  /*
   * THE FINDING IS THE WAY IN. This badge is the loudest thing on the register and used to be a dead
   * end: `dataProcessingAgreementId` was settable on both write paths and appeared in no form, so the
   * screen named a GDPR Article 28(3) gap that the product gave nobody a way to close — and the
   * supplier could not be activated either, because the API refuses a live processor without one.
   *
   * `Badge.onClick` owns the button semantics and the `stopPropagation` a clickable row needs, so this
   * stays a badge rather than becoming a hand-rolled button wrapper.
   */
  /*
   * AND THE ACRONYM IS EXPLAINED WHERE IT IS READ. This badge carried `title="Record the data processing
   * agreement"`, which is invisible on a tablet — the device this register gets reviewed on — and which
   * a screen reader may or may not read out depending on whose it is. "No DPA" in red is also three
   * letters and a colour: it does not say what is missing, which rule wants it, or that the badge is the
   * way to fix it, so a reader who does not already know Article 28(3) is left guessing at the loudest
   * finding on the screen.
   *
   * Only in the interactive case, and that is not a shortcut: a `Badge` without `onClick` renders a
   * `<span>`, which is never focused, so a tooltip on it would be mouse-only help — exactly what this
   * component exists not to be. The read-only reader gets the finding named in the drawer instead.
   */
  if (!onRecordAgreement) return <Badge tone="red">No DPA</Badge>;

  return (
    <Tooltip content="No data processing agreement on file, which GDPR Article 28(3) requires before a processor handles personal data. Opens the form on the agreement field.">
      <Badge tone="red" onClick={onRecordAgreement}>
        No DPA
      </Badge>
    </Tooltip>
  );
}

/**
 * The LAST-ASSESSED cell: the date, and what the assessment concluded.
 *
 * "Never" IS THE POINT, and it is named rather than left blank. An unassessed supplier is the subject of
 * `/reports/review-gaps` and the reason `activate` refuses, so an empty cell would hide the finding the
 * report is built to surface. A conditional pass is toned amber, because it is not a pass.
 */
export function LastAssessedCell({ vendor }: { vendor: Vendor }) {
  if (!vendor.lastAssessedAt) return <span className="text-xs text-warning">Never</span>;
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-xs text-fg-muted">{formatDate(vendor.lastAssessedAt)}</span>
      {vendor.lastOutcome && (
        <Badge tone={outcomeTone(vendor.lastOutcome)}>{humanizeStatus(vendor.lastOutcome)}</Badge>
      )}
    </div>
  );
}
