import type { DbExecutor } from '@platform';
import type {
  ClassificationChange,
  ClassificationLevel,
  ClassificationSummaryLine,
  DeviceHolding,
  InformationAsset,
  InformationAssetFilters,
  InformationAssetRow,
  InformationClassification,
  RegisterAssetInput,
  UpdateAssetInput,
} from '../information-asset.types';

export const INFORMATION_ASSET_REPOSITORY = Symbol('INFORMATION_ASSET_REPOSITORY');

export interface IInformationAssetRepository {
  // ── Levels ─────────────────────────────────────────────────────────────────
  /**
   * The classification levels with their ranks and handling rules.
   *
   * THE ONLY SOURCE OF RANK. Nothing in the application hard-codes the ordering: "is this a
   * reduction in protection?" is a comparison of the ranks read from here, so a level inserted
   * between two others changes the answer without any code changing.
   */
  listLevels(): Promise<ClassificationLevel[]>;

  // ── Register ───────────────────────────────────────────────────────────────
  /**
   * Register an asset and record its first classification, in one transaction.
   *
   * The two are inseparable: an asset whose current label has no history row cannot explain itself,
   * and that first row is what makes the chain complete.
   */
  create(
    input: RegisterAssetInput & { registeredBy: string },
    tx?: DbExecutor,
  ): Promise<InformationAsset>;
  findById(id: string, tx?: DbExecutor): Promise<InformationAsset | null>;
  findByReference(reference: string): Promise<InformationAsset | null>;
  list(
    filters: InformationAssetFilters,
    limit: number,
    offset: number,
  ): Promise<{ rows: InformationAssetRow[]; total: number }>;
  update(id: string, input: UpdateAssetInput, tx?: DbExecutor): Promise<InformationAsset | null>;

  /**
   * Move the classification, guarding the FROM level in the WHERE clause.
   *
   * Returns null when the row no longer carried `from` — which is what makes the change atomic
   * rather than a read-then-write two reviewers can both pass, ending with a history that records
   * a transition that never happened.
   */
  reclassify(
    id: string,
    from: InformationClassification,
    to: InformationClassification,
    tx?: DbExecutor,
  ): Promise<InformationAsset | null>;

  /** Stamp a review as having happened, and optionally move the next one. */
  markReviewed(
    id: string,
    reviewDueOn: string | null,
    tx?: DbExecutor,
  ): Promise<InformationAsset | null>;
  /** Retire an asset. Guarded so it cannot be retired twice. */
  retire(id: string, tx?: DbExecutor): Promise<InformationAsset | null>;

  // ── Classification history ─────────────────────────────────────────────────
  /**
   * Append one history row. There is deliberately no update and no delete — and since migration
   * 0022 the application role holds no UPDATE or DELETE privilege on the table either, so this is
   * not merely the interface's intention.
   */
  appendChange(
    informationAssetId: string,
    input: {
      fromLevel: InformationClassification | null;
      toLevel: InformationClassification;
      reason: string;
      changedBy: string;
    },
    tx?: DbExecutor,
  ): Promise<ClassificationChange>;
  listChanges(informationAssetId: string): Promise<ClassificationChange[]>;

  // ── Devices ────────────────────────────────────────────────────────────────
  linkDevice(
    informationAssetId: string,
    deviceAssetId: string,
    linkedBy: string,
    tx?: DbExecutor,
  ): Promise<void>;
  unlinkDevice(
    informationAssetId: string,
    deviceAssetId: string,
    tx?: DbExecutor,
  ): Promise<boolean>;
  listDevicesFor(informationAssetId: string): Promise<
    {
      deviceAssetId: string;
      assetTag: string;
      type: string;
      status: string;
      assignedTo: string | null;
    }[]
  >;

  // ── Reports ────────────────────────────────────────────────────────────────
  /**
   * What one device holds, worst classification first.
   *
   * The question asked the moment a laptop is reported lost, and the reason the device link is a
   * table rather than a column on either side.
   */
  holdingsOnDevice(deviceAssetId: string): Promise<DeviceHolding[]>;
  /** The register by label — what we hold, and how much of it is personal data. */
  classificationSummary(): Promise<ClassificationSummaryLine[]>;
}
