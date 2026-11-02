/**
 * licenses schema — software/SaaS license inventory and seat assignments.
 */
import {
  pgSchema,
  uuid,
  varchar,
  integer,
  date,
  timestamp,
  index,
  text,
} from 'drizzle-orm/pg-core';
import { licenseTypeEnum, licenseStatusEnum } from './enums';
import { vendors } from './isms-vendors';

export const licensesSchema = pgSchema('licenses');

export const softwareLicenses = licensesSchema.table(
  'software_licenses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 150 }).notNull(),
    vendor: varchar('vendor', { length: 120 }).notNull(),
    licenseType: licenseTypeEnum('license_type').notNull().default('subscription'),
    /** Total seats purchased. Null means unlimited (e.g. site license). */
    seatCount: integer('seat_count'),
    /** Monthly cost per seat in USD cents (e.g. 1500 = $15.00). Null = included. */
    costPerSeatCents: integer('cost_per_seat_cents'),
    renewalDate: date('renewal_date'),
    status: licenseStatusEnum('status').notNull().default('active'),
    notes: text('notes'),
    /** External contract / vendor ID for reference. */
    externalId: varchar('external_id', { length: 200 }),
    /**
     * The supplier in the ISMS vendor register, when they are in it.
     *
     * Added ALONGSIDE the free-text `vendor` above rather than replacing it, which is the same move
     * `roles` made with `employees.job_title`: the text stays because existing screens read it
     * and not every line item deserves a due-diligence file. This column is what makes "what do we
     * buy from this supplier, and has anyone assessed them" a join rather than a string match — and
     * the report worth having is the anti-join, money going to suppliers nobody assessed.
     *
     * `SET NULL`, not `CASCADE`: removing a vendor from the register must never delete a licence.
     */
    vendorId: uuid('vendor_id').references(() => vendors.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    nameIdx: index('ix_sl_name').on(t.name),
    statusIdx: index('ix_sl_status').on(t.status),
    renewalIdx: index('ix_sl_renewal').on(t.renewalDate),
    /** The vendor-spend join, and the anti-join that finds unassessed suppliers. */
    vendorIdx: index('ix_sl_vendor').on(t.vendorId),
  }),
);

export const licenseAssignments = licensesSchema.table(
  'license_assignments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    licenseId: uuid('license_id').notNull(),
    employeeId: uuid('employee_id').notNull(),
    assignedAt: timestamp('assigned_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    notes: varchar('notes', { length: 500 }),
  },
  (t) => ({
    licenseIdx: index('ix_la_license').on(t.licenseId, t.assignedAt),
    employeeIdx: index('ix_la_employee').on(t.employeeId),
  }),
);
