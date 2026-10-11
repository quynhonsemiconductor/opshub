/**
 * compliance schema — software catalog (whitelist/blacklist) + endpoint findings.
 */
import { pgSchema, uuid, varchar, text, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { softwareListingEnum, findingStatusEnum, findingSeverityEnum } from './enums';

export const complianceSchema = pgSchema('compliance');

export const softwareCatalog = complianceSchema.table(
  'software_catalog',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 200 }).notNull(),
    publisher: varchar('publisher', { length: 200 }),
    listing: softwareListingEnum('listing').notNull().default('review'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    nameIdx: uniqueIndex('uq_software_name').on(t.name),
    listingIdx: index('ix_software_listing').on(t.listing),
  }),
);

/**
 * compliance_findings — a non-whitelisted app (or other policy violation)
 * detected on a managed device. Ingested from the EDR/MDM via the worker.
 */
export const complianceFindings = complianceSchema.table(
  'compliance_findings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    assetId: uuid('asset_id'),
    employeeId: uuid('employee_id'),
    softwareName: varchar('software_name', { length: 200 }).notNull(),
    softwareVersion: varchar('software_version', { length: 60 }),
    severity: findingSeverityEnum('severity').notNull().default('medium'),
    status: findingStatusEnum('status').notNull().default('open'),
    /** Source system that raised the finding, e.g. 'defender', 'intune'. */
    source: varchar('source', { length: 255 }).notNull(),
    detectedAt: timestamp('detected_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedBy: uuid('resolved_by'),
    resolutionNote: text('resolution_note'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (t) => ({
    statusIdx: index('ix_finding_status').on(t.status, t.severity),
    assetIdx: index('ix_finding_asset').on(t.assetId),
    employeeIdx: index('ix_finding_employee').on(t.employeeId),
  }),
);
