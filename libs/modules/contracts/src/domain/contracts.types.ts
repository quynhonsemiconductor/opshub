import type { employmentContracts } from '../../../../../db/schema';

export type EmploymentContract = typeof employmentContracts.$inferSelect;
export type ContractType = EmploymentContract['contractType'];
export type ContractStatus = EmploymentContract['status'];
export type SalaryPeriod = NonNullable<EmploymentContract['salaryPeriod']>;

/** The pay terms, which travel together or not at all — `ck_contract_salary_complete`. */
export interface Compensation {
  baseSalary: string;
  salaryCurrency: string;
  salaryPeriod: SalaryPeriod;
}

export interface DraftContractInput {
  employeeId: string;
  roleId?: string | null;
  reference: string;
  contractType: ContractType;
  startDate: string;
  endDate?: string | null;
  probationEndDate?: string | null;
  noticePeriodDays?: number;
  compensation?: Compensation | null;
  documentId?: string | null;
  notes?: string | null;
}

/**
 * What a draft may still change.
 *
 * `employeeId` is absent deliberately: a contract written for the wrong person is a new contract,
 * not an edit, and moving it would rewrite history that the active-contract index depends on.
 */
export type UpdateContractInput = Partial<
  Pick<
    DraftContractInput,
    | 'roleId'
    | 'contractType'
    | 'startDate'
    | 'endDate'
    | 'probationEndDate'
    | 'noticePeriodDays'
    | 'documentId'
    | 'notes'
  >
> & { compensation?: Compensation | null };

export interface ContractFilters {
  employeeId?: string;
  status?: ContractStatus;
  contractType?: ContractType;
  roleId?: string;
  /** Active contracts whose `end_date` falls on or before this date. Drives the renewal queue. */
  endingOnOrBefore?: string;
}

/** One contract due to expire, with just enough context to notify about it. */
export interface ExpiringContract {
  id: string;
  employeeId: string;
  reference: string;
  endDate: string;
}
