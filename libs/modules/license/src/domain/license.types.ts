import type { licenseTypeEnum, licenseStatusEnum } from '../../../../../db/schema';

export type LicenseType = (typeof licenseTypeEnum.enumValues)[number];
export type LicenseStatus = (typeof licenseStatusEnum.enumValues)[number];

export interface SoftwareLicense {
  id: string;
  name: string;
  vendor: string;
  /** The supplier in the ISMS vendor register, when they are in it. */
  vendorId: string | null;
  licenseType: LicenseType;
  seatCount: number | null;
  costPerSeatCents: number | null;
  renewalDate: string | null;
  status: LicenseStatus;
  notes: string | null;
  externalId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface LicenseAssignment {
  id: string;
  licenseId: string;
  employeeId: string;
  assignedAt: Date;
  revokedAt: Date | null;
  notes: string | null;
}

export interface LicenseUtilization {
  licenseId: string;
  name: string;
  vendor: string;
  /** So a caller can leave cancelled and expired licences out of a spend total. */
  status: LicenseStatus;
  seatCount: number | null;
  usedSeats: number;
  availableSeats: number | null;
  utilizationPct: number | null;
  /**
   * WHAT THE ORGANISATION PAYS: seats bought × unit cost.
   *
   * This replaces `monthlySpendCents`, which was `usedSeats × unit cost` — the cost of the seats
   * somebody is sitting in. The two are wildly different on a real register, and the FinOps tile summed
   * the second while the table beside it computed the first, so one screen gave two answers to "what
   * does this cost". Committed is the one a renewal decision is made on: an unassigned seat is still
   * invoiced.
   */
  committedSpendCents: number | null;
  /** The part of the committed spend that is actually in use. The difference is the waste. */
  assignedSpendCents: number | null;
}

export interface CreateLicenseInput {
  name: string;
  vendor: string;
  vendorId?: string | null;
  licenseType: LicenseType;
  seatCount?: number | null;
  costPerSeatCents?: number | null;
  renewalDate?: string | null;
  notes?: string | null;
  externalId?: string | null;
}

export interface UpdateLicenseInput {
  name?: string;
  vendor?: string;
  vendorId?: string | null;
  licenseType?: LicenseType;
  seatCount?: number | null;
  costPerSeatCents?: number | null;
  renewalDate?: string | null;
  status?: LicenseStatus;
  notes?: string | null;
  externalId?: string | null;
}

export interface LicenseFilters {
  status?: LicenseStatus;
  vendor?: string;
  search?: string;
}
