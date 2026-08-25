import {
  Body,
  Controller,
  Delete,
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
  AuthorizedInService,
  AuthzService,
  CurrentUser,
  PermissionDeniedException,
  RequirePermission,
  SelfScoped,
  buildPageResult,
  type JwtPayload,
  type PagedResult,
} from '@platform';
import { PERMISSION } from '@db/permissions.catalog';
import { EmployeeService } from '@modules/identity';
import { PerformanceService } from '../../application/performance.service';
import type {
  CoverageGap,
  CycleProgress,
  PerformanceCycle,
  PerformanceGoal,
  PerformanceRatingLevel,
  PerformanceReview,
} from '../../domain/performance.types';
import {
  CancelReviewDto,
  CoverageGapResponseDto,
  CoverageQueryDto,
  CreateCycleDto,
  CreateReviewDto,
  CycleProgressResponseDto,
  CycleResponseDto,
  GoalResponseDto,
  ListCyclesQueryDto,
  ListReviewsQueryDto,
  RateReviewDto,
  RatingLevelResponseDto,
  ReassignReviewerDto,
  ReviewResponseDto,
  SetGoalDto,
  SubmitSelfAssessmentDto,
} from './dto/performance.dto';

function toCycleDto(c: PerformanceCycle): CycleResponseDto {
  return {
    id: c.id,
    reference: c.reference,
    name: c.name,
    periodStart: c.periodStart,
    periodEnd: c.periodEnd,
    selfAssessmentDue: c.selfAssessmentDue,
    reviewDue: c.reviewDue,
    status: c.status,
    openedAt: c.openedAt?.toISOString() ?? null,
    closedAt: c.closedAt?.toISOString() ?? null,
    createdBy: c.createdBy,
    createdAt: c.createdAt.toISOString(),
  };
}

function toReviewDto(
  r: PerformanceReview & { employeeName?: string | null; reviewerName?: string | null },
): ReviewResponseDto {
  return {
    id: r.id,
    cycleId: r.cycleId,
    employeeId: r.employeeId,
    employeeName: r.employeeName ?? null,
    reviewerId: r.reviewerId,
    reviewerName: r.reviewerName ?? null,
    positionId: r.positionId,
    status: r.status,
    selfAssessment: r.selfAssessment,
    selfAssessmentSubmittedAt: r.selfAssessmentSubmittedAt?.toISOString() ?? null,
    managerSummary: r.managerSummary,
    overallRating: r.overallRating,
    developmentPlan: r.developmentPlan,
    ratedAt: r.ratedAt?.toISOString() ?? null,
    requestId: r.requestId,
    approvedBy: r.approvedBy,
    approvedAt: r.approvedAt?.toISOString() ?? null,
    acknowledgedAt: r.acknowledgedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  };
}

/**
 * The statuses at which a judgement has been DELIBERATELY released to its subject.
 *
 * `shared` is the act of releasing it; `acknowledged` is the subject having read it. Everything else —
 * including `cancelled` — is a draft, and a cancelled draft is the last thing to hand over.
 */
const RELEASED_TO_SUBJECT = new Set(['shared', 'acknowledged']);

/**
 * Blank the manager's judgement when the person reading it is the person being judged and it has not
 * been shared yet.
 *
 * WHY THIS EXISTS. `pending_approval` is a calibration step: a rating is written, then signed off by a
 * holder of `performance.approve`, and only then shared. `performance.approve` is withheld from
 * managers on purpose so that no single person can both write a rating and release it. The READ path
 * walked straight around that control — `GET /performance/me` returned `managerSummary`,
 * `overallRating` and `developmentPlan` with no status gate, so the subject saw their rating the
 * instant their reviewer saved a draft.
 *
 * It went unnoticed because the SPA asserts the opposite in a docblock ("a rating is only visible once
 * the review is SHARED; before that it exists and is not yours to see") and renders "Not shared yet"
 * whenever `overallRating` is null — which looks exactly like a working gate for as long as no draft
 * exists.
 *
 * NOT A PERMISSION CHECK. Reviewers, and anyone holding `performance.read`, still see everything: the
 * point is not secrecy from the organisation, it is that a judgement reaches its subject once, when
 * somebody decides to release it.
 */
function redactUnsharedJudgement(dto: ReviewResponseDto, viewerId: string): ReviewResponseDto {
  if (dto.employeeId !== viewerId) return dto;
  if (RELEASED_TO_SUBJECT.has(dto.status)) return dto;
  return {
    ...dto,
    managerSummary: null,
    overallRating: null,
    developmentPlan: null,
    // `ratedAt` goes too: "rated last Tuesday, contents withheld" tells the subject a judgement
    // exists and is being withheld, which is worse than not knowing it has been started.
    ratedAt: null,
  };
}

/** The same rule for a goal's grade, which is half of the judgement. */
function redactUnsharedGoal(
  dto: GoalResponseDto,
  review: { employeeId: string; status: string },
  viewerId: string,
): GoalResponseDto {
  if (review.employeeId !== viewerId) return dto;
  if (RELEASED_TO_SUBJECT.has(review.status)) return dto;
  return { ...dto, rating: null, outcome: null };
}

function toGoalDto(g: PerformanceGoal): GoalResponseDto {
  return {
    id: g.id,
    reviewId: g.reviewId,
    title: g.title,
    description: g.description,
    target: g.target,
    // numeric(5,2) arrives from the driver as a string; the API contract is a number.
    weight: Number(g.weight),
    outcome: g.outcome,
    rating: g.rating,
  };
}

function toRatingLevelDto(l: PerformanceRatingLevel): RatingLevelResponseDto {
  return { ...l };
}

function toCoverageGapDto(g: CoverageGap): CoverageGapResponseDto {
  return { ...g };
}

function toProgressDto(p: CycleProgress): CycleProgressResponseDto {
  return { status: p.status, count: Number(p.count) };
}

@ApiTags('performance')
@Controller('performance')
@Auth()
export class PerformanceController {
  constructor(
    private readonly service: PerformanceService,
    private readonly employees: EmployeeService,
    private readonly authz: AuthzService,
  ) {}

  /** Does the caller hold `performance.read`? Resolved the way `PolicyGuard` resolves it. */
  private canRead(user: JwtPayload): Promise<boolean> {
    return this.authz.check(user.sub, PERMISSION.PERFORMANCE_READ, undefined, user);
  }

  /**
   * A review is readable by the three people it concerns, or by anyone holding `performance.read`.
   *
   * The subject, the reviewer and whoever holds the permission — nobody else. A performance review is
   * the most personal record in OpsHub, so this is deliberately narrower than the module's other
   * reads: `employee.read` gets you a directory, not somebody's rating.
   */
  private async mustSeeReview(user: JwtPayload, id: string): Promise<PerformanceReview> {
    const review = await this.service.getReview(id);
    if (review.employeeId === user.sub || review.reviewerId === user.sub) return review;
    if (await this.canRead(user)) return review;
    throw new PermissionDeniedException('That review is not yours to read');
  }

  // ── Mine ───────────────────────────────────────────────────────────────────

  /**
   * The caller's own reviews, newest first.
   *
   * Self-scoped and first because it is the only route most employees need. Your own rating is not
   * privileged information about anyone else.
   */
  @Get('me')
  @SelfScoped("returns the caller's own reviews — keyed on their own id")
  @ApiOperation({ summary: 'My performance reviews, newest first' })
  @ApiPagedResponse(ReviewResponseDto)
  @ApiCommonErrors(401)
  async myReviews(
    @Query() query: ListReviewsQueryDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<PagedResult<ReviewResponseDto>> {
    const { rows, total } = await this.service.listReviews(
      { employeeId: user.sub, cycleId: query.cycleId, status: query.status },
      query.limit,
      query.offset,
    );
    return buildPageResult(
      // The caller may be the subject of one of these rows — `/reviews` is a permissioned list, and
      // holding `performance.read` does not release your own unshared rating to you.
      rows.map((r) => redactUnsharedJudgement(toReviewDto(r), user.sub)),
      total,
      query.limit,
      query.offset,
    );
  }

  /** The reviews the caller has to write. */
  @Get('me/to-review')
  @SelfScoped('returns the reviews ASSIGNED to the caller — keyed on their own id')
  @ApiOperation({ summary: 'Reviews assigned to me to write' })
  @ApiPagedResponse(ReviewResponseDto)
  @ApiCommonErrors(401)
  async assignedToMe(
    @Query() query: ListReviewsQueryDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<PagedResult<ReviewResponseDto>> {
    const { rows, total } = await this.service.listReviews(
      { reviewerId: user.sub, cycleId: query.cycleId, status: query.status },
      query.limit,
      query.offset,
    );
    return buildPageResult(
      // The caller may be the subject of one of these rows — `/reviews` is a permissioned list, and
      // holding `performance.read` does not release your own unshared rating to you.
      rows.map((r) => redactUnsharedJudgement(toReviewDto(r), user.sub)),
      total,
      query.limit,
      query.offset,
    );
  }

  // ── The rating scale ───────────────────────────────────────────────────────

  /**
   * The rating scale, worst first.
   *
   * Needs no permission: a scale everybody is judged against that only some people can read is not a
   * scale. `requiresDevelopmentPlan` is here too, so a reviewer knows before they rate.
   */
  @Get('rating-scale')
  @AuthorizedInService(
    'the rating scale is published to everyone — a scale you are judged against is not a secret',
    'performance.e2e.spec.ts',
  )
  @ApiOperation({ summary: 'The rating scale, worst first' })
  @ApiOkResponse({ type: [RatingLevelResponseDto] })
  @ApiCommonErrors(401)
  async ratingScale(): Promise<RatingLevelResponseDto[]> {
    return (await this.service.listRatingScale()).map(toRatingLevelDto);
  }

  // ── Cycles ─────────────────────────────────────────────────────────────────

  @Get('cycles')
  @RequirePermission(PERMISSION.PERFORMANCE_READ)
  @ApiOperation({ summary: 'List review cycles, most recent period first' })
  @ApiPagedResponse(CycleResponseDto)
  @ApiCommonErrors(401, 403)
  async listCycles(@Query() query: ListCyclesQueryDto): Promise<PagedResult<CycleResponseDto>> {
    const { rows, total } = await this.service.listCycles(
      query.status ?? 'all',
      query.limit,
      query.offset,
    );
    return buildPageResult(rows.map(toCycleDto), total, query.limit, query.offset);
  }

  @Post('cycles')
  @RequirePermission(PERMISSION.PERFORMANCE_MANAGE)
  @ApiOperation({
    summary: 'Create a review cycle',
    description:
      'Starts as a draft: reviews can only be created once it is opened. `reviewDue` must be on ' +
      'or after `periodEnd` — a period cannot be reviewed before it has ended.',
  })
  @ApiCreatedResponse({ type: CycleResponseDto })
  @ApiCommonErrors(401, 403, 409, 412, 422)
  async createCycle(
    @Body() dto: CreateCycleDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<CycleResponseDto> {
    return toCycleDto(await this.service.createCycle(dto, user));
  }

  @Get('cycles/:id')
  @RequirePermission(PERMISSION.PERFORMANCE_READ)
  @ApiOperation({ summary: 'One cycle' })
  @ApiOkResponse({ type: CycleResponseDto })
  @ApiCommonErrors(401, 403, 404)
  async getCycle(@Param('id', ParseUUIDPipe) id: string): Promise<CycleResponseDto> {
    return toCycleDto(await this.service.getCycle(id));
  }

  @Post('cycles/:id/open')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(PERMISSION.PERFORMANCE_MANAGE)
  @ApiOperation({ summary: 'Open a cycle for reviews' })
  @ApiOkResponse({ type: CycleResponseDto })
  @ApiCommonErrors(401, 403, 404, 412)
  async openCycle(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<CycleResponseDto> {
    return toCycleDto(await this.service.openCycle(id, user));
  }

  @Post('cycles/:id/close')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(PERMISSION.PERFORMANCE_MANAGE)
  @ApiOperation({
    summary: 'Close a cycle',
    description:
      'Refused while any review is neither acknowledged nor cancelled (412 ' +
      '`PERFORMANCE_CYCLE_HAS_OPEN_REVIEWS`) — closing regardless would report a cycle as ' +
      'finished that nobody finished. The coverage report says which ones.',
  })
  @ApiOkResponse({ type: CycleResponseDto })
  @ApiCommonErrors(401, 403, 404, 412)
  async closeCycle(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<CycleResponseDto> {
    return toCycleDto(await this.service.closeCycle(id, user));
  }

  @Get('cycles/:id/progress')
  @RequirePermission(PERMISSION.PERFORMANCE_READ)
  @ApiOperation({ summary: 'How many reviews sit in each state of a cycle' })
  @ApiOkResponse({ type: [CycleProgressResponseDto] })
  @ApiCommonErrors(401, 403, 404)
  async cycleProgress(@Param('id', ParseUUIDPipe) id: string): Promise<CycleProgressResponseDto[]> {
    return (await this.service.cycleProgress(id)).map(toProgressDto);
  }

  /**
   * Who has not been reviewed, paged.
   *
   * WHY THIS IS PAGED NOW. It passed a hard `500` and returned a bare array, so an organisation with
   * more than five hundred active employees got a report that omitted people and said nothing about it.
   * Of every list in this product that is the worst one to truncate silently: the answer it gives is
   * "these are the ones still outstanding", and a short answer reads as progress.
   *
   * It also made a test lie. `performance.e2e.spec.ts` asserts that an employee with no review appears,
   * and it failed on a database that had accumulated 848 active employees — a correct assertion, a real
   * ceiling, and nothing in the response that would have told anybody which of the two was wrong.
   */
  @Get('cycles/:id/coverage')
  @RequirePermission(PERMISSION.PERFORMANCE_READ)
  @ApiOperation({
    summary: 'Who has not been reviewed in this cycle',
    description:
      'Active employees with NO review, and those whose review has stalled short of ' +
      'acknowledgement. Both are "not done": a report showing only the first would call a cycle ' +
      'complete while half its reviews sat unsigned. Missing reviews come first. ' +
      'Paged: `pageInfo.total` is every outstanding person, not the size of this page, so a caller ' +
      'can tell a complete answer from a first page.',
  })
  @ApiPagedResponse(CoverageGapResponseDto)
  @ApiCommonErrors(401, 403, 404)
  async coverage(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: CoverageQueryDto,
  ): Promise<PagedResult<CoverageGapResponseDto>> {
    const { rows, total } = await this.service.coverageGaps(id, query.limit, query.offset);
    return buildPageResult(rows.map(toCoverageGapDto), total, query.limit, query.offset);
  }

  @Post('cycles/:id/reviews')
  @RequirePermission(PERMISSION.PERFORMANCE_MANAGE)
  @ApiOperation({
    summary: 'Create the review for one employee',
    description:
      "Freezes the employee's CURRENT position on the review: a transfer afterwards does not " +
      'restate what the review was about. Refused if the reviewer is the employee (412 ' +
      '`PERFORMANCE_SELF_REVIEW`) or the cycle is not open (412 `PERFORMANCE_CYCLE_NOT_OPEN`).',
  })
  @ApiCreatedResponse({ type: ReviewResponseDto })
  @ApiCommonErrors(401, 403, 404, 409, 412, 422)
  async createReview(
    @Param('id', ParseUUIDPipe) cycleId: string,
    @Body() dto: CreateReviewDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<ReviewResponseDto> {
    // Both people must exist: `employee_id` and `reviewer_id` carry no cross-schema FK, so a typo
    // would otherwise create a review nobody can act on.
    await this.employees.assertExist(dto.employeeId, dto.reviewerId);
    return toReviewDto(await this.service.createReview({ ...dto, cycleId }, user));
  }

  // ── Reviews ────────────────────────────────────────────────────────────────

  @Get('reviews')
  @RequirePermission(PERMISSION.PERFORMANCE_READ)
  @ApiOperation({ summary: 'List reviews, newest first' })
  @ApiPagedResponse(ReviewResponseDto)
  @ApiCommonErrors(401, 403)
  async listReviews(
    @Query() query: ListReviewsQueryDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<PagedResult<ReviewResponseDto>> {
    const { rows, total } = await this.service.listReviews(
      {
        cycleId: query.cycleId,
        employeeId: query.employeeId,
        reviewerId: query.reviewerId,
        status: query.status,
      },
      query.limit,
      query.offset,
    );
    return buildPageResult(
      // The caller may be the subject of one of these rows — `/reviews` is a permissioned list, and
      // holding `performance.read` does not release your own unshared rating to you.
      rows.map((r) => redactUnsharedJudgement(toReviewDto(r), user.sub)),
      total,
      query.limit,
      query.offset,
    );
  }

  @Get('reviews/:id')
  @AuthorizedInService(
    'the subject and the reviewer may read it; anyone else needs performance.read',
    'performance.e2e.spec.ts',
  )
  @ApiOperation({ summary: 'One review' })
  @ApiOkResponse({ type: ReviewResponseDto })
  @ApiCommonErrors(401, 403, 404)
  async getReview(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<ReviewResponseDto> {
    return redactUnsharedJudgement(toReviewDto(await this.mustSeeReview(user, id)), user.sub);
  }

  @Get('reviews/:id/goals')
  @AuthorizedInService(
    "the subject and the reviewer may read a review's goals; anyone else needs performance.read",
    'performance.e2e.spec.ts',
  )
  @ApiOperation({ summary: "A review's goals, heaviest first" })
  @ApiOkResponse({ type: [GoalResponseDto] })
  @ApiCommonErrors(401, 403, 404)
  async listGoals(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<GoalResponseDto[]> {
    const review = await this.mustSeeReview(user, id);
    return (await this.service.listGoals(id)).map((g) =>
      redactUnsharedGoal(toGoalDto(g), review, user.sub),
    );
  }

  @Patch('reviews/:id/reviewer')
  @RequirePermission(PERMISSION.PERFORMANCE_MANAGE)
  @ApiOperation({
    summary: 'Reassign the reviewer',
    description:
      'Only while the review is still being written. Once it has been submitted for sign-off, ' +
      'changing who wrote it would misattribute a judgement somebody else made.',
  })
  @ApiOkResponse({ type: ReviewResponseDto })
  @ApiCommonErrors(401, 403, 404, 412, 422)
  async reassign(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReassignReviewerDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<ReviewResponseDto> {
    await this.employees.assertExist(dto.reviewerId);
    return toReviewDto(await this.service.reassignReviewer(id, dto.reviewerId, user));
  }

  @Post('reviews/:id/self-assessment')
  @HttpCode(HttpStatus.OK)
  @AuthorizedInService(
    'only the SUBJECT writes their own self-assessment — nobody else, permission or not',
    'performance.e2e.spec.ts',
  )
  @ApiOperation({
    summary: 'Submit my self-assessment',
    description:
      'Hands the review to the reviewer. Only the employee it is about may do this — a ' +
      'self-assessment written by somebody else is not one, so `performance.manage` does not ' +
      'help here.',
  })
  @ApiOkResponse({ type: ReviewResponseDto })
  @ApiCommonErrors(401, 403, 404, 412, 422)
  async submitSelfAssessment(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SubmitSelfAssessmentDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<ReviewResponseDto> {
    const review = await this.service.getReview(id);
    if (review.employeeId !== user.sub) {
      throw new PermissionDeniedException('Only you can write your own self-assessment');
    }
    return toReviewDto(await this.service.submitSelfAssessment(id, dto.selfAssessment, user));
  }

  @Post('reviews/:id/goals')
  @AuthorizedInService(
    'the assigned reviewer sets goals; anyone else needs performance.manage',
    'performance.e2e.spec.ts',
  )
  @ApiOperation({
    summary: 'Set or edit a goal',
    description:
      'Keyed on the title, so re-sending one EDITS it rather than adding a second — otherwise the ' +
      'weights would be double-counted. Weights must total 100 by the time the review is ' +
      'submitted, which is when a partial set stops being a legal step towards a complete one.',
  })
  @ApiCreatedResponse({ type: GoalResponseDto })
  @ApiCommonErrors(401, 403, 404, 409, 412, 422)
  async setGoal(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetGoalDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<GoalResponseDto> {
    await this.mustWriteReview(user, id);
    return toGoalDto(await this.service.setGoal({ ...dto, reviewId: id }, user));
  }

  @Delete('reviews/:id/goals/:goalId')
  @AuthorizedInService(
    'the assigned reviewer removes goals; anyone else needs performance.manage',
    'performance.e2e.spec.ts',
  )
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a goal' })
  @ApiCommonErrors(401, 403, 404, 409, 412)
  async removeGoal(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('goalId', ParseUUIDPipe) goalId: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<void> {
    await this.mustWriteReview(user, id);
    await this.service.removeGoal(id, goalId, user);
  }

  @Post('reviews/:id/rating')
  @HttpCode(HttpStatus.OK)
  @AuthorizedInService(
    'only the ASSIGNED REVIEWER may rate — enforced in the service, which owns the reviewer check',
    'performance.e2e.spec.ts',
  )
  @ApiOperation({
    summary: 'Record the rating',
    description:
      'Does NOT submit it: a rating is drafted, discussed and revised, and a call that did both ' +
      'would put every draft in front of an approver. A rating whose scale entry demands a ' +
      'development plan is refused without one (412 `PERFORMANCE_DEVELOPMENT_PLAN_REQUIRED`).',
  })
  @ApiOkResponse({ type: ReviewResponseDto })
  @ApiCommonErrors(401, 403, 404, 412, 422)
  async rate(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RateReviewDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<ReviewResponseDto> {
    return toReviewDto(await this.service.rate(id, dto, user));
  }

  @Post('reviews/:id/submit')
  @HttpCode(HttpStatus.OK)
  @AuthorizedInService(
    'only the ASSIGNED REVIEWER may submit for sign-off — enforced in the service',
    'performance.e2e.spec.ts',
  )
  @ApiOperation({
    summary: 'Send the rating for calibration sign-off',
    description:
      'Creates a `performance_review` request for somebody holding `performance.approve`. The ' +
      'goals must total 100% and all be graded (412 `PERFORMANCE_GOAL_WEIGHTS_INVALID`); a review ' +
      'with no goals at all is allowed, since the first cycle an organisation runs has none.',
  })
  @ApiOkResponse({ type: ReviewResponseDto })
  @ApiCommonErrors(401, 403, 404, 412)
  async submit(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<ReviewResponseDto> {
    return toReviewDto(await this.service.submitForApproval(id, user));
  }

  @Post('reviews/:id/acknowledge')
  @HttpCode(HttpStatus.OK)
  @AuthorizedInService(
    'only the SUBJECT acknowledges their own review — an acknowledgement by anyone else is worthless',
    'performance.e2e.spec.ts',
  )
  @ApiOperation({
    summary: 'Acknowledge my review',
    description:
      'The employee confirming the review was discussed with them. Only they can: an ' +
      'acknowledgement recorded by somebody else is evidence of nothing.',
  })
  @ApiOkResponse({ type: ReviewResponseDto })
  @ApiCommonErrors(401, 403, 404, 412)
  async acknowledge(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<ReviewResponseDto> {
    const review = await this.service.getReview(id);
    if (review.employeeId !== user.sub) {
      throw new PermissionDeniedException('Only you can acknowledge your own review');
    }
    return toReviewDto(await this.service.acknowledge(id, user));
  }

  @Post('reviews/:id/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(PERMISSION.PERFORMANCE_MANAGE)
  @ApiOperation({
    summary: 'Withdraw a review',
    description:
      'Possible until the employee has seen it, and not after: a review somebody has read cannot ' +
      'be made to have never happened.',
  })
  @ApiOkResponse({ type: ReviewResponseDto })
  @ApiCommonErrors(401, 403, 404, 412, 422)
  async cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelReviewDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<ReviewResponseDto> {
    return toReviewDto(await this.service.cancelReview(id, dto.reason, user));
  }

  /**
   * The assigned reviewer may write the review; anybody else needs `performance.manage`.
   *
   * HR sets up the goals for a cycle, and the reviewer refines them — so both routes exist for both
   * people. Rating is narrower and lives in the service, because a rating attributed to the wrong
   * person is a different kind of wrong from an edited goal.
   */
  private async mustWriteReview(user: JwtPayload, id: string): Promise<PerformanceReview> {
    const review = await this.service.getReview(id);
    if (review.reviewerId === user.sub) return review;
    if (await this.authz.check(user.sub, PERMISSION.PERFORMANCE_MANAGE, undefined, user)) {
      return review;
    }
    throw new PermissionDeniedException('Only the assigned reviewer may change this review');
  }
}
