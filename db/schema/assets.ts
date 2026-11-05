/**
 * assets schema — hardware inventory + assignment history.
 */
import {
  pgSchema,
  uuid,
  varchar,
  jsonb,
  timestamp,
  date,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { assetTypeEnum, assetStatusEnum } from './enums';

export const assetsSchema = pgSchema('assets');

export const assets = assetsSchema.table(
  'assets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Human-readable asset tag, e.g. "LT-00421". */
    assetTag: varchar('asset_tag', { length: 50 }).notNull(),
    type: assetTypeEnum('type').notNull(),
    status: assetStatusEnum('status').notNull().default('in_stock'),
    manufacturer: varchar('manufacturer', { length: 120 }),
    model: varchar('model', { length: 120 }),
    serialNumber: varchar('serial_number', { length: 120 }),
    /** Device id in the MDM (e.g. Intune managedDeviceId) for correlation. */
    mdmDeviceId: varchar('mdm_device_id', { length: 128 }),
    purchaseDate: date('purchase_date'),
    warrantyExpiry: date('warranty_expiry'),
    specs: jsonb('specs').notNull().$type<Record<string, unknown>>().default({}),
    /** Currently assigned employee, null when in stock. */
    assignedTo: uuid('assigned_to'),
    /** S3 key for a photo of the physical asset (optional). */
    photoStorageKey: varchar('photo_storage_key', { length: 512 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tagIdx: uniqueIndex('uq_asset_tag').on(t.assetTag),
    serialIdx: index('ix_asset_serial').on(t.serialNumber),
    statusIdx: index('ix_asset_status').on(t.status),
    assignedIdx: index('ix_asset_assigned_to').on(t.assignedTo),
  }),
);

export const assetAssignments = assetsSchema.table(
  'asset_assignments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    assetId: uuid('asset_id').notNull(),
    employeeId: uuid('employee_id').notNull(),
    assignedAt: timestamp('assigned_at', { withTimezone: true }).notNull().defaultNow(),
    returnedAt: timestamp('returned_at', { withTimezone: true }),
    notes: varchar('notes', { length: 500 }),
  },
  (t) => ({
    assetIdx: index('ix_assignment_asset').on(t.assetId, t.assignedAt),
    employeeIdx: index('ix_assignment_employee').on(t.employeeId),
  }),
);
