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
  CurrentUser,
  RequirePermission,
  buildPageResult,
  type JwtPayload,
  type PagedResult,
} from '@platform';
import { EmployeeService } from '@modules/identity';
import { ManagementReviewService } from '../../application/management-review.service';
import type {
  ManagementReview,
  ManagementReviewAction,
  ManagementReviewRow,
  ReviewActionRow,
} from '../../domain/management-review.types';
import {
  CancelReviewDto,
  CarriedForwardActionResponseDto,
  CloseReviewDto,
  HoldReviewDto,
  ListReviewActionsQueryDto,
  ListReviewsQueryDto,
  ManagementReviewResponseDto,
  ManagementReviewRowResponseDto,
  RaiseReviewActionDto,
  ReviewActionOutcomeDto,
  ReviewActionResponseDto,
  ReviewActionRowResponseDto,
  ReviewAgendaResponseDto,
  ScheduleReviewDto,
  UpdateReviewActionDto,
  UpdateReviewDto,
} from './dto/qms.dto';

/**
 * `chairName` is optional on the way in and always present on the way out: the read paths resolve it,
 * the lifecycle routes do not, because the SPA discards their responses and refetches.
 */
function toDto(r: ManagementReview & { chairName?: string | null }): ManagementReviewResponseDto {
  return {
    id: r.id,
    reference: r.reference,
    title: r.title,
    period: r.period,
    status: r.status,
    chairId: r.chairId,
    chairName: r.chairName ?? null,
    scheduledFor: r.scheduledFor,
    heldOn: r.heldOn,
    inputs: r.inputs,
    conclusion: r.conclusion,
    minutesDocumentId: r.minutesDocumentId,
    closedAt: r.closedAt?.toISOString() ?? null,
    cancelReason: r.cancelReason,
    createdAt: r.createdAt.toISOString(),
  };
}

function toRowDto(
  r: ManagementReviewRow & { chairName?: string | null },
): ManagementReviewRowResponseDto {
  return { ...toDto(r), actionCount: r.actionCount, openActionCount: r.openActionCount };
}

function toActionDto(
  a: ManagementReviewAction & { ownerName?: string | null },
): ReviewActionResponseDto {
  return {
    id: a.id,
    managementReviewId: a.managementReviewId,
    category: a.category,
    description: a.description,
    ownerId: a.ownerId,
    ownerName: a.ownerName ?? null,
    dueOn: a.dueOn,
    status: a.status,
    completedAt: a.completedAt?.toISOString() ?? null,
    outcomeNote: a.outcomeNote,
    createdAt: a.createdAt.toISOString(),
  };
}

function toActionRowDto(
  r: ReviewActionRow & { ownerName?: string | null },
): ReviewActionRowResponseDto {
  return { ...toActionDto(r), reviewReference: r.reviewReference, reviewPeriod: r.reviewPeriod };
}

@ApiTags('management-reviews')
@Controller('management-reviews')
@Auth()
export class ManagementReviewController {
  constructor(
    private readonly service: ManagementReviewService,
    private readonly employees: EmployeeService,
  ) {}

  // ── Static paths first, before `:id` ─────────────────────────────────────────

  @Get('agenda')
  @RequirePermission('management_review.read')
  @ApiOperation({
    summary: 'The §9.3.2 inputs, assembled live from the registers that own them',
    description:
      'Every item the clause lists is something another register already answers: non-conformities ' +
      'and corrective actions (c)(4), audit results (c)(6), the performance of external providers ' +
      '(c)(7), the effectiveness of actions on risks (e), and the status of actions from previous ' +
      'reviews (a). This composes them rather than storing copies. COUNTS AND REFERENCES ONLY — the ' +
      "clause asks for trends and aggregate performance, and returning the registers' rows here " +
      'would make this a way around their own permissions.',
  })
  @ApiOkResponse({ type: ReviewAgendaResponseDto })
  @ApiCommonErrors(401, 403)
  async agenda(): Promise<ReviewAgendaResponseDto> {
    return this.service.assembleAgenda(null);
  }

  @Get('actions')
  @RequirePermission('management_review.read')
  @ApiOperation({
    summary: 'Actions out of management reviews',
    description:
      'Soonest due first, undated last. Each row carries the review it came out of. `dueOnOrBefore` ' +
      "with today's date is the overdue follow-up list.",
  })
  @ApiPagedResponse(ReviewActionRowResponseDto)
  @ApiCommonErrors(401, 403)
  async listActions(
    @Query() query: ListReviewActionsQueryDto,
  ): Promise<PagedResult<ReviewActionRowResponseDto>> {
    const { rows, total } = await this.service.listActions(
      {
        status: query.status,
        category: query.category,
        ownerId: query.ownerId,
        managementReviewId: query.managementReviewId,
        openOnly: query.openOnly,
        dueOnOrBefore: query.dueOnOrBefore,
      },
      query.limit,
      query.offset,
    );
    return buildPageResult(rows.map(toActionRowDto), total, query.limit, query.offset);
  }

  @Get('actions/carried-forward')
  @RequirePermission('management_review.read')
  @ApiOperation({
    summary: 'Open actions from earlier reviews — the §9.3.2(a) input',
    description:
      'Most overdue first. The next review freezes this list into its own inputs when it is held, ' +
      'which is how "the status of actions from previous management reviews" is satisfied by ' +
      'construction rather than by somebody remembering to look.',
  })
  @ApiOkResponse({ type: [CarriedForwardActionResponseDto] })
  @ApiCommonErrors(401, 403)
  async carriedForward(): Promise<CarriedForwardActionResponseDto[]> {
    return this.service.carriedForward();
  }

  // ── The programme ────────────────────────────────────────────────────────────

  @Get()
  @RequirePermission('management_review.read')
  @ApiOperation({
    summary: 'The management review programme',
    description: 'Soonest scheduled first, undated last. Each row carries its action counts.',
  })
  @ApiPagedResponse(ManagementReviewRowResponseDto)
  @ApiCommonErrors(401, 403)
  async list(
    @Query() query: ListReviewsQueryDto,
  ): Promise<PagedResult<ManagementReviewRowResponseDto>> {
    const { rows, total } = await this.service.list(
      {
        status: query.status,
        chairId: query.chairId,
        openOnly: query.openOnly,
        scheduledOnOrBefore: query.scheduledOnOrBefore,
        search: query.search,
      },
      query.limit,
      query.offset,
    );
    return buildPageResult(rows.map(toRowDto), total, query.limit, query.offset);
  }

  @Post()
  @RequirePermission('management_review.manage')
  @ApiOperation({
    summary: 'Schedule a review',
    description:
      'The chair is required: §9.3 is a TOP MANAGEMENT obligation, and a review with nobody ' +
      'accountable for having held it is the box-ticking the clause exists to prevent.',
  })
  @ApiCreatedResponse({ type: ManagementReviewResponseDto })
  @ApiCommonErrors(400, 401, 403, 404, 409, 412)
  async schedule(
    @Body() dto: ScheduleReviewDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<ManagementReviewResponseDto> {
    // `chair_id` carries no cross-schema FK, so without this a typo would name nobody.
    await this.employees.assertExist(dto.chairId);
    return toDto(await this.service.schedule(dto, user));
  }

  // ── Actions, BEFORE the `:id` routes ─────────────────────────────────────────
  //
  // Nest matches in declaration order, so `PATCH /management-reviews/actions/<uuid>` would otherwise
  // be handed to `PATCH :id` with `id = 'actions'`, where `ParseUUIDPipe` turns it into a puzzling
  // 400. The `POST :id/actions` route below is a different shape (two segments against three) and
  // cannot collide, but these share their segment count with the by-id routes.

  @Patch('actions/:actionId')
  @RequirePermission('management_review.manage')
  @ApiOperation({ summary: 'Correct an open action' })
  @ApiOkResponse({ type: ReviewActionResponseDto })
  @ApiCommonErrors(400, 401, 403, 404, 412)
  async updateAction(
    @Param('actionId', ParseUUIDPipe) actionId: string,
    @Body() dto: UpdateReviewActionDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<ReviewActionResponseDto> {
    await this.employees.assertExist(dto.ownerId);
    return toActionDto(await this.service.updateAction(actionId, dto, user));
  }

  @Post('actions/:actionId/start')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('management_review.manage')
  @ApiOperation({ summary: 'Begin work on an action' })
  @ApiOkResponse({ type: ReviewActionResponseDto })
  @ApiCommonErrors(401, 403, 404, 409, 412)
  async startAction(
    @Param('actionId', ParseUUIDPipe) actionId: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<ReviewActionResponseDto> {
    return toActionDto(await this.service.startAction(actionId, user));
  }

  @Post('actions/:actionId/complete')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('management_review.manage')
  @ApiOperation({
    summary: 'Record an action as done',
    description:
      'The outcome note is required. Until an action is completed or cancelled it stays on the ' +
      "carried-forward list and lands in the NEXT review's frozen inputs, which is §9.3.2(a).",
  })
  @ApiOkResponse({ type: ReviewActionResponseDto })
  @ApiCommonErrors(400, 401, 403, 404, 409, 412)
  async completeAction(
    @Param('actionId', ParseUUIDPipe) actionId: string,
    @Body() dto: ReviewActionOutcomeDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<ReviewActionResponseDto> {
    return toActionDto(await this.service.completeAction(actionId, dto.outcomeNote, user));
  }

  @Post('actions/:actionId/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('management_review.manage')
  @ApiOperation({ summary: 'Abandon an action, with a reason' })
  @ApiOkResponse({ type: ReviewActionResponseDto })
  @ApiCommonErrors(400, 401, 403, 404, 409, 412)
  async cancelAction(
    @Param('actionId', ParseUUIDPipe) actionId: string,
    @Body() dto: ReviewActionOutcomeDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<ReviewActionResponseDto> {
    return toActionDto(await this.service.cancelAction(actionId, dto.outcomeNote, user));
  }

  @Get(':id')
  @RequirePermission('management_review.read')
  @ApiOperation({
    summary: 'One review, with its frozen inputs once held',
    description:
      '`inputs` is the §9.3.2 bundle as it stood on the day. A live re-read would silently turn ' +
      '"eleven findings overdue" into "three" once the backlog cleared, and the decision recorded ' +
      'beside it would stop making sense.',
  })
  @ApiOkResponse({ type: ManagementReviewResponseDto })
  @ApiCommonErrors(401, 403, 404)
  async getOne(@Param('id', ParseUUIDPipe) id: string): Promise<ManagementReviewResponseDto> {
    // `getWithChair`, not `getById` — see its docblock for why the guard the lifecycle routes share
    // was not widened to do this.
    return toDto(await this.service.getWithChair(id));
  }

  @Get(':id/agenda')
  @RequirePermission('management_review.read')
  @ApiOperation({
    summary: 'The agenda for THIS review, excluding its own actions',
    description:
      'The same composition as `GET /management-reviews/agenda`, minus the actions this review itself ' +
      'raised — at the moment it is held those are outputs it has just produced, not history it is ' +
      'reviewing. This is exactly what `hold` freezes.',
  })
  @ApiOkResponse({ type: ReviewAgendaResponseDto })
  @ApiCommonErrors(401, 403, 404)
  async agendaFor(@Param('id', ParseUUIDPipe) id: string): Promise<ReviewAgendaResponseDto> {
    await this.service.getById(id);
    return this.service.assembleAgenda(id);
  }

  @Patch(':id')
  @RequirePermission('management_review.manage')
  @ApiOperation({
    summary: 'Correct a scheduled review',
    description:
      'Only while `scheduled`: after it is held, the title and period label a snapshot that was ' +
      'frozen under them. `inputs` is not settable at any point — it is composed by the service.',
  })
  @ApiOkResponse({ type: ManagementReviewResponseDto })
  @ApiCommonErrors(400, 401, 403, 404, 412)
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateReviewDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<ManagementReviewResponseDto> {
    await this.employees.assertExist(dto.chairId);
    return toDto(await this.service.update(id, dto, user));
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  @Post(':id/hold')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('management_review.manage')
  @ApiOperation({
    summary: 'Hold the review, FREEZING its §9.3.2 inputs',
    description:
      'The snapshot is assembled by the server and written in the same transaction as the ' +
      'transition, so a held review always has one. Refused while a review scheduled EARLIER is ' +
      'still outstanding: §9.3.2(a) asks this review for the status of actions from previous ones, ' +
      'which only means something if "previous" is settled.',
  })
  @ApiOkResponse({ type: ManagementReviewResponseDto })
  @ApiCommonErrors(400, 401, 403, 404, 409, 412)
  async hold(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: HoldReviewDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<ManagementReviewResponseDto> {
    return toDto(await this.service.hold(id, dto.heldOn, user));
  }

  @Post(':id/close')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('management_review.manage')
  @ApiOperation({
    summary: 'Issue the minutes (§9.3.3)',
    description:
      'Its own state, not a timestamp on holding: a meeting that happened and whose minutes were ' +
      'never issued is not a completed review. Both the conclusion and the minutes document are ' +
      'required, and the review raises no further actions afterwards — one added then would be an ' +
      'output those minutes do not contain.',
  })
  @ApiOkResponse({ type: ManagementReviewResponseDto })
  @ApiCommonErrors(400, 401, 403, 404, 409, 412)
  async close(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CloseReviewDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<ManagementReviewResponseDto> {
    return toDto(await this.service.close(id, dto.conclusion, dto.minutesDocumentId, user));
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('management_review.manage')
  @ApiOperation({
    summary: 'Record a review that did not happen',
    description:
      'Only from `scheduled`. Once a review has been held its inputs are frozen and its actions ' +
      'raised, and none of that is cancellable.',
  })
  @ApiOkResponse({ type: ManagementReviewResponseDto })
  @ApiCommonErrors(400, 401, 403, 404, 409, 412)
  async cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelReviewDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<ManagementReviewResponseDto> {
    return toDto(await this.service.cancel(id, dto.reason, user));
  }

  // ── Actions (§9.3.3) ─────────────────────────────────────────────────────────

  @Post(':id/actions')
  @RequirePermission('management_review.manage')
  @ApiOperation({
    summary: 'Raise a decision or action out of the review',
    description:
      "`category` is §9.3.3's own closed list — improvement, a change to the QMS, or a resource " +
      'need. There is deliberately no `other`: that value would let every action be filed as ' +
      'unclassifiable, which is what the list exists to prevent. Refused once the review is closed.',
  })
  @ApiCreatedResponse({ type: ReviewActionResponseDto })
  @ApiCommonErrors(400, 401, 403, 404, 412)
  async raiseAction(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RaiseReviewActionDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<ReviewActionResponseDto> {
    await this.employees.assertExist(dto.ownerId);
    return toActionDto(await this.service.raiseAction(id, dto, user));
  }
}
