import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiOkResponse, ApiCreatedResponse } from '@nestjs/swagger';
import {
  Auth,
  CurrentUser,
  type JwtPayload,
  RequestEngine,
  buildPageResult,
  type PagedResult,
  NotFoundException,
  ErrorCodes,
  type RequestItemWithApprovals,
  type RequestComment,
  ApiPagedResponse,
  AuthorizedInService,
} from '@platform';
import { AuditService, AUDIT_ACTION, AUDIT_RESOURCE } from '@modules/audit';
import {
  ListRequestsQueryDto,
  ReviewRequestDto,
  AddCommentDto,
  RequestItemResponseDto,
  RequestApprovalResponseDto,
  RequestCommentResponseDto,
} from './dto/requests.dto';

function toApprovalDto(
  a: RequestItemWithApprovals['approvals'][number],
): RequestApprovalResponseDto {
  return {
    id: a.id,
    requestId: a.requestId,
    step: a.step,
    approverId: a.approverId,
    // Null rather than the id when the approver's employee row is gone: falling back to the uuid would
    // put back the very thing the name replaced.
    approverName: a.approverName ?? null,
    decision: a.decision,
    note: a.note,
    delegatedFromId: a.delegatedFromId,
    decidedAt: a.decidedAt.toISOString(),
  };
}

function toDto(r: RequestItemWithApprovals): RequestItemResponseDto {
  return {
    id: r.id,
    type: r.type,
    requesterId: r.requesterId,
    requesterName: r.requesterName ?? null,
    // Defaults to "no", so a path that forgets to compute it hides the actions rather than offering
    // one the API will refuse.
    viewerMayDecide: r.viewerMayDecide ?? false,
    viewerCannotDecideReason: r.viewerCannotDecideReason ?? null,
    assigneeId: r.assigneeId,
    // Null covers both an unassigned request and an assignee whose employee row is gone; the client shows
    // a dash for either, and `assigneeId` is what tells them apart.
    assigneeName: r.assigneeName ?? null,
    status: r.status,
    priority: r.priority,
    payload: r.payload,
    resolutionNote: r.resolutionNote,
    submittedAt: r.submittedAt.toISOString(),
    resolvedAt: r.resolvedAt ? r.resolvedAt.toISOString() : null,
    expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
    slaHours: r.slaHours,
    slaDeadline: r.slaDeadline ? r.slaDeadline.toISOString() : null,
    slaBreachedAt: r.slaBreachedAt ? r.slaBreachedAt.toISOString() : null,
    currentStep: r.currentStep,
    totalSteps: r.totalSteps,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    approvals: r.approvals.map(toApprovalDto),
  };
}

function toCommentDto(c: RequestComment): RequestCommentResponseDto {
  return {
    id: c.id,
    requestId: c.requestId,
    authorId: c.authorId,
    body: c.body,
    editedAt: c.editedAt ? c.editedAt.toISOString() : null,
    createdAt: c.createdAt.toISOString(),
  };
}

@ApiTags('requests')
@Controller('requests')
@Auth()
export class RequestsController {
  constructor(
    private readonly engine: RequestEngine,
    private readonly audit: AuditService,
  ) {}

  private async mustGetById(id: string, actor: JwtPayload): Promise<RequestItemWithApprovals> {
    const item = await this.engine.getById(id, actor);
    if (!item) {
      throw new NotFoundException(ErrorCodes.REQUEST_NOT_FOUND, 'Request not found');
    }
    return item;
  }

  /**
   * Unified inbox — lists request items across all types.
   * Use `myQueue=true` to get requests awaiting the caller's action.
   */
  @Get()
  @AuthorizedInService(
    'narrows to requester-or-assignee unless the caller holds request.read',
    'request-visibility.e2e.spec.ts',
  )
  @ApiOperation({ summary: 'List request items (unified inbox)' })
  @ApiPagedResponse(RequestItemResponseDto)
  async list(
    @Query() query: ListRequestsQueryDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<PagedResult<RequestItemResponseDto>> {
    const { rows, total } = await this.engine.list(
      {
        type: query.type,
        status: query.status,
        requesterId: query.requesterId,
        myQueue: query.myQueue,
      },
      user.sub,
      query.limit,
      query.offset,
    );

    // engine.list() now batch-loads approvals — no N+1
    return buildPageResult(rows.map(toDto), total, query.limit, query.offset);
  }

  /** Get a single request item with its full approval history. */
  @Get(':id')
  @AuthorizedInService(
    'assertParty on requester/assignee, else request.read',
    'request-visibility.e2e.spec.ts',
  )
  @ApiOperation({ summary: 'Get request item with approval history' })
  @ApiOkResponse({ type: RequestItemResponseDto })
  async getById(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<RequestItemResponseDto> {
    return toDto(await this.mustGetById(id, user));
  }

  /** Approve a pending request. Requires the relevant `*.approve` permission. */
  @Post(':id/approve')
  // 200, not Nest's default 201: this is a state transition, not a creation, and `@ApiOkResponse`
  // already promises 200 — without this the generated client's contract disagreed with the server.
  @HttpCode(HttpStatus.OK)
  @AuthorizedInService(
    'required permission comes from the request TYPE and current STEP; unions actor with an active delegator and enforces separation of duties',
    'request-engine.spec.ts',
  )
  @ApiOperation({ summary: 'Approve a pending request' })
  @ApiOkResponse({ type: RequestItemResponseDto })
  async approve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReviewRequestDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<RequestItemResponseDto> {
    await this.engine.approve(id, dto.note ?? null, user);
    void this.audit.record({
      actorId: user.sub,
      actorEmail: user.email,
      action: AUDIT_ACTION.REQUEST_APPROVED,
      resourceType: AUDIT_RESOURCE.REQUEST,
      resourceId: id,
      metadata: { note: dto.note ?? null },
    });
    return toDto(await this.mustGetById(id, user));
  }

  /** Reject a pending request. Requires the relevant `*.approve` permission. */
  @Post(':id/reject')
  // 200, not Nest's default 201: this is a state transition, not a creation, and `@ApiOkResponse`
  // already promises 200 — without this the generated client's contract disagreed with the server.
  @HttpCode(HttpStatus.OK)
  @AuthorizedInService('same step-derived permission as approve', 'request-engine.spec.ts')
  @ApiOperation({ summary: 'Reject a pending request' })
  @ApiOkResponse({ type: RequestItemResponseDto })
  async reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReviewRequestDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<RequestItemResponseDto> {
    await this.engine.reject(id, dto.note ?? null, user);
    void this.audit.record({
      actorId: user.sub,
      actorEmail: user.email,
      action: AUDIT_ACTION.REQUEST_REJECTED,
      resourceType: AUDIT_RESOURCE.REQUEST,
      resourceId: id,
      metadata: { note: dto.note ?? null },
    });
    return toDto(await this.mustGetById(id, user));
  }

  /** Cancel a pending request (requester or admin). */
  @Post(':id/cancel')
  // 200, not Nest's default 201: this is a state transition, not a creation, and `@ApiOkResponse`
  // already promises 200 — without this the generated client's contract disagreed with the server.
  @HttpCode(HttpStatus.OK)
  @AuthorizedInService('requester, or a holder of rbac.manage', 'request-engine.spec.ts')
  @ApiOperation({ summary: 'Cancel a pending request' })
  @ApiOkResponse({ type: RequestItemResponseDto })
  async cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReviewRequestDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<RequestItemResponseDto> {
    await this.engine.cancel(id, user);
    void this.audit.record({
      actorId: user.sub,
      actorEmail: user.email,
      action: AUDIT_ACTION.REQUEST_CANCELLED,
      resourceType: AUDIT_RESOURCE.REQUEST,
      resourceId: id,
    });
    return toDto(await this.mustGetById(id, user));
  }

  // ── Comments ───────────────────────────────────────────────────────────────

  /**
   * List discussion comments on a request, ordered oldest-first.
   * Comments are informational only — they do not affect request state.
   */
  @Get(':id/comments')
  @AuthorizedInService(
    'assertParty on the owning request, else request.read',
    'request-visibility.e2e.spec.ts',
  )
  @ApiOperation({ summary: 'List comments on a request' })
  @ApiOkResponse({ type: [RequestCommentResponseDto] })
  async listComments(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<RequestCommentResponseDto[]> {
    // Ensure request exists (throws 404 if not) and the caller is a party to it
    await this.mustGetById(id, user);
    const comments = await this.engine.listComments(id, user);
    return comments.map(toCommentDto);
  }

  /** Post a discussion comment. Does not trigger any state transition. */
  @Post(':id/comments')
  @AuthorizedInService(
    'assertParty on the owning request before the write, else request.read',
    'request-visibility.e2e.spec.ts',
  )
  @HttpCode(201)
  @ApiOperation({ summary: 'Post a comment on a request' })
  @ApiCreatedResponse({ type: RequestCommentResponseDto })
  async addComment(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddCommentDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<RequestCommentResponseDto> {
    const comment = await this.engine.addComment(id, dto.body, user);
    void this.audit.record({
      actorId: user.sub,
      actorEmail: user.email,
      action: AUDIT_ACTION.REQUEST_COMMENT_ADDED,
      resourceType: AUDIT_RESOURCE.REQUEST,
      resourceId: id,
      metadata: { commentId: comment.id },
    });
    return toCommentDto(comment);
  }
}
