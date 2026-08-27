import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ApiCommonErrors,
  ApiPagedResponse,
  Auth,
  AuthzService,
  CurrentUser,
  RequirePermission,
  SelfScoped,
  buildPageResult,
  type JwtPayload,
  type PagedResult,
} from '@platform';
import { PERMISSION } from '@db/permissions.catalog';
import { EmployeeService } from '@modules/identity';
import { DocumentsService } from '@modules/documents';
import { ContractsService } from '../../application/contracts.service';
import type { EmploymentContract } from '../../domain/contracts.types';
import {
  ActivateContractDto,
  ContractResponseDto,
  DraftContractDto,
  ListContractsQueryDto,
  RenewContractDto,
  TerminateContractDto,
  UpdateContractDto,
} from './dto/contracts.dto';

/**
 * Contract → response, with the pay terms attached only when the caller may see them.
 *
 * ONE mapper, taking the decision as an argument rather than two mappers that could drift: a second
 * "redacted" mapper is exactly how a new field gets added to one and not the other.
 */
function toContractDto(
  c: EmploymentContract & { employeeName?: string | null },
  compensation: boolean,
): ContractResponseDto {
  return {
    id: c.id,
    employeeId: c.employeeId,
    employeeName: c.employeeName ?? null,
    positionId: c.positionId,
    reference: c.reference,
    contractType: c.contractType,
    startDate: c.startDate,
    endDate: c.endDate,
    probationEndDate: c.probationEndDate,
    noticePeriodDays: c.noticePeriodDays,
    status: c.status,
    signedAt: c.signedAt?.toISOString() ?? null,
    documentId: c.documentId,
    terminatedOn: c.terminatedOn,
    terminationReason: c.terminationReason,
    supersededById: c.supersededById,
    notes: c.notes,
    createdAt: c.createdAt.toISOString(),
    compensation:
      compensation && c.baseSalary && c.salaryCurrency && c.salaryPeriod
        ? {
            baseSalary: c.baseSalary,
            salaryCurrency: c.salaryCurrency,
            salaryPeriod: c.salaryPeriod,
          }
        : null,
  };
}

@ApiTags('contracts')
@Controller('contracts')
@Auth()
export class ContractsController {
  constructor(
    private readonly service: ContractsService,
    private readonly employees: EmployeeService,
    private readonly documents: DocumentsService,
    private readonly authz: AuthzService,
  ) {}

  /**
   * May this caller see pay figures on these contracts?
   *
   * True when they hold `contract.compensation.read`, or when every contract in hand is their own —
   * an employee's salary is theirs, which is a scope rule rather than a permission. Resolved through
   * `AuthzService.check`, the same path `PolicyGuard` uses, so a wildcard or module-wide grant is
   * honoured here exactly as it is on a route.
   */
  private async maySeePay(user: JwtPayload, contracts: EmploymentContract[]): Promise<boolean> {
    if (contracts.length > 0 && contracts.every((c) => c.employeeId === user.sub)) return true;
    return this.authz.check(user.sub, PERMISSION.CONTRACT_COMPENSATION_READ, undefined, user);
  }

  /**
   * The caller's own contracts, newest first, INCLUDING pay.
   *
   * Self-scoped and first because it is the only route here most employees need. What you are paid
   * and until when is not privileged information about anyone else.
   */
  @Get('me')
  @SelfScoped("returns the caller's own contracts — keyed on their own id")
  @ApiOperation({ summary: 'My contracts, newest first' })
  @ApiOkResponse({ type: [ContractResponseDto] })
  @ApiCommonErrors(401)
  async myContracts(@CurrentUser() user: JwtPayload): Promise<ContractResponseDto[]> {
    return (await this.service.listForEmployee(user.sub)).map((c) => toContractDto(c, true));
  }

  @Get()
  @RequirePermission('contract.read')
  @ApiOperation({
    summary: 'List contracts',
    description:
      'Pay figures appear only for a caller holding `contract.compensation.read`; otherwise ' +
      '`compensation` is null. `endingOnOrBefore` narrows to ACTIVE contracts ending by that ' +
      'date — the renewal queue.',
  })
  @ApiPagedResponse(ContractResponseDto)
  @ApiCommonErrors(401, 403)
  async list(
    @Query() query: ListContractsQueryDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<PagedResult<ContractResponseDto>> {
    const { rows, total } = await this.service.listContracts(
      {
        employeeId: query.employeeId,
        status: query.status,
        contractType: query.contractType,
        positionId: query.positionId,
        endingOnOrBefore: query.endingOnOrBefore,
      },
      query.limit,
      query.offset,
    );
    const pay = await this.maySeePay(user, rows);
    return buildPageResult(
      rows.map((c) => toContractDto(c, pay)),
      total,
      query.limit,
      query.offset,
    );
  }

  @Get(':id')
  @RequirePermission('contract.read')
  @ApiOperation({ summary: 'Get a contract' })
  @ApiOkResponse({ type: ContractResponseDto })
  @ApiCommonErrors(401, 403, 404)
  async getById(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<ContractResponseDto> {
    const contract = await this.service.getContractWithEmployee(id);
    return toContractDto(contract, await this.maySeePay(user, [contract]));
  }

  @Get('employees/:employeeId/history')
  @RequirePermission('contract.read')
  @ApiOperation({ summary: "One employee's contract history, newest first" })
  @ApiOkResponse({ type: [ContractResponseDto] })
  @ApiCommonErrors(401, 403, 404)
  async employeeHistory(
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<ContractResponseDto[]> {
    await this.employees.assertExist(employeeId);
    const rows = await this.service.listForEmployee(employeeId);
    const pay = await this.maySeePay(user, rows);
    return rows.map((c) => toContractDto(c, pay));
  }

  @Post()
  @RequirePermission('contract.manage')
  @ApiOperation({
    summary: 'Draft a contract',
    description:
      'Created as a DRAFT — a contract is negotiated before it binds anyone. `permanent` must ' +
      'have no end date; every other type must have one (`CONTRACT_INVALID_TERM`).',
  })
  @ApiCreatedResponse({ type: ContractResponseDto })
  @ApiCommonErrors(401, 403, 404, 409, 412, 422)
  async draft(
    @Body() dto: DraftContractDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<ContractResponseDto> {
    // `employee_id` carries no cross-schema FK, matching every other module, so without this a typo
    // would become a contract for somebody who does not exist.
    await this.employees.assertExist(dto.employeeId);
    // `document_id` carries no cross-schema FK. A contract row naming a document nobody can open
    // is the compliance record that reads as complete and is not.
    await this.documents.assertExist(dto.documentId);
    return toContractDto(await this.service.draftContract(dto, user), true);
  }

  @Patch(':id')
  @RequirePermission('contract.manage')
  @ApiOperation({
    summary: 'Change a draft',
    description:
      "Drafts only. An active contract's terms are what somebody signed, so changing them is a " +
      'renewal (`CONTRACT_NOT_DRAFT`).',
  })
  @ApiOkResponse({ type: ContractResponseDto })
  @ApiCommonErrors(401, 403, 404, 409, 412, 422)
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateContractDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<ContractResponseDto> {
    // The PATCH accepts `documentId` too, so the draft route's check alone would leave the correction
    // path open — which is the one somebody uses after mistyping it the first time.
    await this.documents.assertExist(dto.documentId);
    return toContractDto(await this.service.updateContract(id, dto, user), true);
  }

  @Post(':id/activate')
  // A state transition, not a creation: 200, and the documented status is then the real one.
  @HttpCode(HttpStatus.OK)
  @RequirePermission('contract.manage')
  @ApiOperation({
    summary: 'Make a draft the live contract',
    description:
      'Refused when the employee already holds an active contract — replacing one is a renewal ' +
      '(`CONTRACT_ALREADY_ACTIVE`) — and when nobody has signed (`CONTRACT_NOT_SIGNED`).',
  })
  @ApiOkResponse({ type: ContractResponseDto })
  @ApiCommonErrors(401, 403, 404, 409, 412, 422)
  async activate(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ActivateContractDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<ContractResponseDto> {
    return toContractDto(await this.service.activateContract(id, dto, user), true);
  }

  @Post(':id/renew')
  // A state transition, not a creation: 200, and the documented status is then the real one.
  @HttpCode(HttpStatus.OK)
  @RequirePermission('contract.manage')
  @ApiOperation({
    summary: 'Replace an active contract with a drafted one',
    description:
      'One transaction: the outgoing contract expires, the incoming one activates, and the ' +
      'outgoing row is linked to its successor. Same employee only.',
  })
  @ApiOkResponse({ type: ContractResponseDto })
  @ApiCommonErrors(401, 403, 404, 409, 412, 422)
  async renew(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RenewContractDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<ContractResponseDto> {
    return toContractDto(
      await this.service.renewContract(id, dto.incomingContractId, dto, user),
      true,
    );
  }

  @Post(':id/terminate')
  // A state transition, not a creation: 200, and the documented status is then the real one.
  @HttpCode(HttpStatus.OK)
  @RequirePermission('contract.manage')
  @ApiOperation({
    summary: 'End an active contract by decision',
    description: 'A reason is required — a termination nobody can account for is worse than none.',
  })
  @ApiOkResponse({ type: ContractResponseDto })
  @ApiCommonErrors(401, 403, 404, 409, 412, 422)
  async terminate(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TerminateContractDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<ContractResponseDto> {
    return toContractDto(await this.service.terminateContract(id, dto, user), true);
  }
}
