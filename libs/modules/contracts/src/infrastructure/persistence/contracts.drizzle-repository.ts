import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { InjectDrizzle, type DbExecutor, type DrizzleDB } from '@platform';
import { newId } from '@shared-kernel';
import { employmentContracts } from '../../../../../../db/schema';
import type { IContractsRepository } from '../../domain/ports/contracts.repository';
import type {
  ContractFilters,
  DraftContractInput,
  EmploymentContract,
  ExpiringContract,
  UpdateContractInput,
} from '../../domain/contracts.types';

/** The three compensation columns are one fact; `null` clears all three together. */
function compensationColumns(input: Pick<UpdateContractInput, 'compensation'>) {
  if (input.compensation === undefined) return {};
  return input.compensation === null
    ? { baseSalary: null, salaryCurrency: null, salaryPeriod: null }
    : {
        baseSalary: input.compensation.baseSalary,
        salaryCurrency: input.compensation.salaryCurrency,
        salaryPeriod: input.compensation.salaryPeriod,
      };
}

@Injectable()
export class ContractsDrizzleRepository implements IContractsRepository {
  constructor(@InjectDrizzle() private readonly db: DrizzleDB) {}

  async create(input: DraftContractInput, tx?: DbExecutor): Promise<EmploymentContract> {
    const [row] = await (tx ?? this.db)
      .insert(employmentContracts)
      .values({
        id: newId(),
        employeeId: input.employeeId,
        roleId: input.roleId ?? null,
        reference: input.reference,
        contractType: input.contractType,
        startDate: input.startDate,
        endDate: input.endDate ?? null,
        probationEndDate: input.probationEndDate ?? null,
        noticePeriodDays: input.noticePeriodDays ?? 30,
        documentId: input.documentId ?? null,
        notes: input.notes ?? null,
        ...compensationColumns(input),
      })
      .returning();
    return row;
  }

  async findById(id: string, tx?: DbExecutor): Promise<EmploymentContract | null> {
    const [row] = await (tx ?? this.db)
      .select()
      .from(employmentContracts)
      .where(eq(employmentContracts.id, id))
      .limit(1);
    return row ?? null;
  }

  async findByReference(reference: string): Promise<EmploymentContract | null> {
    const [row] = await this.db
      .select()
      .from(employmentContracts)
      .where(eq(employmentContracts.reference, reference))
      .limit(1);
    return row ?? null;
  }

  async list(
    filters: ContractFilters,
    limit: number,
    offset: number,
  ): Promise<{ rows: EmploymentContract[]; total: number }> {
    const where = and(
      filters.employeeId ? eq(employmentContracts.employeeId, filters.employeeId) : undefined,
      filters.status ? eq(employmentContracts.status, filters.status) : undefined,
      filters.contractType ? eq(employmentContracts.contractType, filters.contractType) : undefined,
      filters.roleId ? eq(employmentContracts.roleId, filters.roleId) : undefined,
      // The renewal queue: only an ACTIVE contract can be renewed, so the status is implied by the
      // filter rather than left to the caller to remember.
      filters.endingOnOrBefore
        ? and(
            eq(employmentContracts.status, 'active'),
            lte(employmentContracts.endDate, filters.endingOnOrBefore),
          )
        : undefined,
    );

    const rows = await this.db
      .select()
      .from(employmentContracts)
      .where(where)
      // Newest first, `id` last: `start_date` is not unique, so without a unique tiebreaker
      // pagination silently drops and repeats rows.
      .orderBy(desc(employmentContracts.startDate), asc(employmentContracts.id))
      .limit(limit)
      .offset(offset);

    const [{ count }] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(employmentContracts)
      .where(where);

    return { rows, total: count };
  }

  async listForEmployee(employeeId: string): Promise<EmploymentContract[]> {
    return this.db
      .select()
      .from(employmentContracts)
      .where(eq(employmentContracts.employeeId, employeeId))
      .orderBy(desc(employmentContracts.startDate), asc(employmentContracts.id));
  }

  async findActiveForEmployee(
    employeeId: string,
    tx?: DbExecutor,
  ): Promise<EmploymentContract | null> {
    const [row] = await (tx ?? this.db)
      .select()
      .from(employmentContracts)
      .where(
        and(
          eq(employmentContracts.employeeId, employeeId),
          eq(employmentContracts.status, 'active'),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async update(
    id: string,
    input: UpdateContractInput,
    tx?: DbExecutor,
  ): Promise<EmploymentContract | null> {
    // `compensation` is destructured OUT and expanded by `compensationColumns`, because the three
    // columns are one fact: passing it through as a nested object would not match any column.
    const { compensation, ...rest } = input;
    const [row] = await (tx ?? this.db)
      .update(employmentContracts)
      .set({ ...rest, ...compensationColumns({ compensation }), updatedAt: new Date() })
      // Drafts only. An active contract's terms are what somebody signed; changing them is a
      // renewal, and the WHERE clause is what makes that unavoidable rather than a convention.
      .where(and(eq(employmentContracts.id, id), eq(employmentContracts.status, 'draft')))
      .returning();
    return row ?? null;
  }

  async transition(
    id: string,
    from: EmploymentContract['status'],
    to: EmploymentContract['status'],
    extra: Partial<
      Pick<EmploymentContract, 'signedAt' | 'terminatedOn' | 'terminationReason' | 'supersededById'>
    >,
    tx?: DbExecutor,
  ): Promise<EmploymentContract | null> {
    const [row] = await (tx ?? this.db)
      .update(employmentContracts)
      .set({ status: to, ...extra, updatedAt: new Date() })
      // The FROM state is in the WHERE clause, not checked beforehand: two concurrent callers would
      // both pass a read-then-write, and only one can win an UPDATE.
      .where(and(eq(employmentContracts.id, id), eq(employmentContracts.status, from)))
      .returning();
    return row ?? null;
  }

  async listExpired(asOf: string, limit: number): Promise<ExpiringContract[]> {
    return this.db
      .select({
        id: employmentContracts.id,
        employeeId: employmentContracts.employeeId,
        reference: employmentContracts.reference,
        endDate: sql<string>`${employmentContracts.endDate}`,
      })
      .from(employmentContracts)
      .where(and(eq(employmentContracts.status, 'active'), lte(employmentContracts.endDate, asOf)))
      .orderBy(asc(employmentContracts.endDate), asc(employmentContracts.id))
      .limit(limit);
  }

  async listExpiringBetween(from: string, to: string, limit: number): Promise<ExpiringContract[]> {
    return this.db
      .select({
        id: employmentContracts.id,
        employeeId: employmentContracts.employeeId,
        reference: employmentContracts.reference,
        endDate: sql<string>`${employmentContracts.endDate}`,
      })
      .from(employmentContracts)
      .where(
        and(
          eq(employmentContracts.status, 'active'),
          gte(employmentContracts.endDate, from),
          lte(employmentContracts.endDate, to),
        ),
      )
      .orderBy(asc(employmentContracts.endDate), asc(employmentContracts.id))
      .limit(limit);
  }
}
