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
  RateLimit,
  RequirePermission,
  SelfScoped,
  buildPageResult,
  type EntityAttachment,
  type JwtPayload,
  type PagedResult,
} from '@platform';
import { PERMISSION } from '@db/permissions.catalog';
import { EmployeeService } from '@modules/identity';
import { TrainingService } from '../../application/training.service';
import type {
  CompetencyGap,
  TrainingCourse,
  TrainingRecord,
  TrainingRequirement,
} from '../../domain/training.types';
import {
  AddRequirementDto,
  CertificateResponseDto,
  CompetencyGapQueryDto,
  CompetencyGapResponseDto,
  CourseResponseDto,
  CreateCourseDto,
  DownloadUrlResponseDto,
  ListCoursesQueryDto,
  ListRecordsQueryDto,
  PresignCertificateDto,
  PresignCertificateResponseDto,
  RecordCompletionDto,
  RequirementResponseDto,
  RevokeRecordDto,
  TrainingRecordResponseDto,
  UpdateCourseDto,
} from './dto/training.dto';

function toCourseDto(c: TrainingCourse): CourseResponseDto {
  return {
    id: c.id,
    code: c.code,
    title: c.title,
    category: c.category,
    provider: c.provider,
    description: c.description,
    validityMonths: c.validityMonths,
    retiredAt: c.retiredAt?.toISOString() ?? null,
    createdAt: c.createdAt.toISOString(),
  };
}

function toRequirementDto(
  r: TrainingRequirement & { courseCode: string; courseTitle: string },
): RequirementResponseDto {
  return {
    id: r.id,
    positionId: r.positionId,
    courseId: r.courseId,
    courseCode: r.courseCode,
    courseTitle: r.courseTitle,
    kind: r.kind,
    graceDays: r.graceDays,
  };
}

function toRecordDto(
  r: TrainingRecord & { employeeName?: string | null },
): TrainingRecordResponseDto {
  return {
    id: r.id,
    employeeId: r.employeeId,
    // Optional on the way in and null on the way out: the read paths resolve it, the write paths do
    // not, and the shape stays one DTO rather than two that differ by a single field.
    employeeName: r.employeeName ?? null,
    courseId: r.courseId,
    completedOn: r.completedOn,
    expiresOn: r.expiresOn,
    result: r.result,
    score: r.score,
    status: r.status,
    verifiedBy: r.verifiedBy,
    verifiedAt: r.verifiedAt?.toISOString() ?? null,
    supersededById: r.supersededById,
    revokedReason: r.revokedReason,
    notes: r.notes,
    createdAt: r.createdAt.toISOString(),
  };
}

function toCertificateDto(a: EntityAttachment): CertificateResponseDto {
  return {
    fileId: a.fileId,
    fileName: a.fileName,
    mimeType: a.mimeType,
    sizeBytes: a.sizeBytes,
    checksumSha256: a.checksumSha256,
    uploadedBy: a.uploadedBy,
    attachedBy: a.attachedBy,
    attachedAt: a.attachedAt.toISOString(),
  };
}

function toGapDto(g: CompetencyGap & { employeeName?: string | null }): CompetencyGapResponseDto {
  return { ...g, employeeName: g.employeeName ?? null };
}

@ApiTags('training')
@Controller('training')
@Auth()
export class TrainingController {
  constructor(
    private readonly service: TrainingService,
    private readonly employees: EmployeeService,
    private readonly authz: AuthzService,
  ) {}

  /** Does the caller hold `training.manage`? Resolved the same way `PolicyGuard` resolves it. */
  private canManage(user: JwtPayload): Promise<boolean> {
    return this.authz.check(user.sub, PERMISSION.TRAINING_MANAGE, undefined, user);
  }

  /**
   * The caller may act on this record if they hold `training.manage`, or if it is their OWN.
   *
   * Uploading the certificate for a course you took is the ordinary flow, and it needs no
   * permission — the record already names who it belongs to. Verifying it DOES, which is the
   * separation the ISO control actually asks for: the person who took the course is not the person
   * who attests that the evidence is genuine.
   */
  private async assertMayAttach(user: JwtPayload, recordId: string): Promise<boolean> {
    const record = await this.service.getRecord(recordId);
    if (record.employeeId === user.sub) return false;
    if (await this.canManage(user)) return true;
    throw new PermissionDeniedException(
      'You may only attach certificates to your own training records',
    );
  }

  // ── My training ──────────────────────────────────────────────────────────────

  /**
   * The caller's own records, newest first.
   *
   * Self-scoped and first because it is the only route here most employees need. What training you
   * hold and when it lapses is not privileged information about anyone else.
   */
  @Get('me')
  @SelfScoped("returns the caller's own training records — keyed on their own id")
  @ApiOperation({ summary: 'My training records, newest first' })
  @ApiOkResponse({ type: [TrainingRecordResponseDto] })
  @ApiCommonErrors(401)
  async myRecords(@CurrentUser() user: JwtPayload): Promise<TrainingRecordResponseDto[]> {
    return (await this.service.listRecordsForEmployee(user.sub)).map(toRecordDto);
  }

  /** The caller's own gaps — what their current position requires and they do not hold. */
  @Get('me/gaps')
  @SelfScoped("returns the caller's own competency gaps — keyed on their own id")
  @ApiOperation({ summary: 'Training my current position requires and I do not hold' })
  @ApiOkResponse({ type: [CompetencyGapResponseDto] })
  @ApiCommonErrors(401)
  async myGaps(@CurrentUser() user: JwtPayload): Promise<CompetencyGapResponseDto[]> {
    return (await this.service.competencyGaps({ employeeId: user.sub })).map(toGapDto);
  }

  // ── Courses ──────────────────────────────────────────────────────────────────

  @Get('courses')
  @RequirePermission('training.read')
  @ApiOperation({
    summary: 'List courses',
    description: 'Retired courses are hidden unless `includeRetired` is set.',
  })
  @ApiPagedResponse(CourseResponseDto)
  @ApiCommonErrors(401, 403)
  async listCourses(@Query() query: ListCoursesQueryDto): Promise<PagedResult<CourseResponseDto>> {
    const { rows, total } = await this.service.listCourses(
      { category: query.category, includeRetired: query.includeRetired },
      query.limit,
      query.offset,
    );
    return buildPageResult(rows.map(toCourseDto), total, query.limit, query.offset);
  }

  @Post('courses')
  @RequirePermission('training.manage')
  @ApiOperation({ summary: 'Add a course to the catalogue' })
  @ApiCreatedResponse({ type: CourseResponseDto })
  @ApiCommonErrors(401, 403, 409, 422)
  async createCourse(
    @Body() dto: CreateCourseDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<CourseResponseDto> {
    return toCourseDto(await this.service.createCourse(dto, user));
  }

  @Get('courses/:id')
  @RequirePermission('training.read')
  @ApiOperation({ summary: 'Get a course' })
  @ApiOkResponse({ type: CourseResponseDto })
  @ApiCommonErrors(401, 403, 404)
  async getCourse(@Param('id', ParseUUIDPipe) id: string): Promise<CourseResponseDto> {
    return toCourseDto(await this.service.getCourse(id));
  }

  @Patch('courses/:id')
  @RequirePermission('training.manage')
  @ApiOperation({
    summary: 'Change a course',
    description:
      'Changing `validityMonths` governs the NEXT completion only — existing records keep the ' +
      'expiry frozen at the moment they were earned.',
  })
  @ApiOkResponse({ type: CourseResponseDto })
  @ApiCommonErrors(401, 403, 404, 422)
  async updateCourse(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCourseDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<CourseResponseDto> {
    return toCourseDto(await this.service.updateCourse(id, dto, user));
  }

  @Post('courses/:id/retire')
  // A state transition, not a creation: 200, and the documented status is then the real one.
  @HttpCode(HttpStatus.OK)
  @RequirePermission('training.manage')
  @ApiOperation({
    summary: 'Retire a course',
    description: 'It stays in the catalogue — past records reference it — but accepts nothing new.',
  })
  @ApiOkResponse({ type: CourseResponseDto })
  @ApiCommonErrors(401, 403, 404, 412)
  async retireCourse(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<CourseResponseDto> {
    return toCourseDto(await this.service.retireCourse(id, user));
  }

  // ── Requirements ─────────────────────────────────────────────────────────────

  @Get('positions/:positionId/requirements')
  @RequirePermission('training.read')
  @ApiOperation({ summary: 'Courses a position requires' })
  @ApiOkResponse({ type: [RequirementResponseDto] })
  @ApiCommonErrors(401, 403)
  async listRequirements(
    @Param('positionId', ParseUUIDPipe) positionId: string,
  ): Promise<RequirementResponseDto[]> {
    return (await this.service.listRequirementsForPosition(positionId)).map(toRequirementDto);
  }

  @Post('positions/:positionId/requirements')
  @RequirePermission('training.manage')
  @ApiOperation({
    summary: 'Require a course of a position',
    description:
      'The requirement hangs off the POSITION, not the person, so a transfer changes what ' +
      'somebody needs with no backfill.',
  })
  @ApiCreatedResponse({ type: RequirementResponseDto })
  @ApiCommonErrors(401, 403, 404, 409, 412, 422)
  async addRequirement(
    @Param('positionId', ParseUUIDPipe) positionId: string,
    @Body() dto: AddRequirementDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<RequirementResponseDto> {
    const requirement = await this.service.addRequirement({ ...dto, positionId }, user);
    const course = await this.service.getCourse(requirement.courseId);
    return toRequirementDto({
      ...requirement,
      courseCode: course.code,
      courseTitle: course.title,
    });
  }

  @Delete('requirements/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('training.manage')
  @ApiOperation({ summary: 'Stop requiring a course of a position' })
  @ApiCommonErrors(401, 403, 404)
  async removeRequirement(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<void> {
    await this.service.removeRequirement(id, user);
  }

  // ── Records ──────────────────────────────────────────────────────────────────

  @Get('records')
  @RequirePermission('training.read')
  @ApiOperation({
    summary: 'List training records',
    description:
      '`currentOnly` drops superseded rows — what "their current training" means. ' +
      '`expiringOnOrBefore` narrows to LIVE records lapsing by that date.',
  })
  @ApiPagedResponse(TrainingRecordResponseDto)
  @ApiCommonErrors(401, 403)
  async listRecords(
    @Query() query: ListRecordsQueryDto,
  ): Promise<PagedResult<TrainingRecordResponseDto>> {
    const { rows, total } = await this.service.listRecords(
      {
        employeeId: query.employeeId,
        courseId: query.courseId,
        status: query.status,
        expiringOnOrBefore: query.expiringOnOrBefore,
        currentOnly: query.currentOnly,
      },
      query.limit,
      query.offset,
    );
    return buildPageResult(rows.map(toRecordDto), total, query.limit, query.offset);
  }

  @Post('records')
  @RequirePermission('training.manage')
  @ApiOperation({
    summary: 'Record a completion',
    description:
      'Supersedes whatever the employee currently holds for that course, in one transaction. ' +
      '`expiresOn` is derived from the course and then frozen.',
  })
  @ApiCreatedResponse({ type: TrainingRecordResponseDto })
  @ApiCommonErrors(401, 403, 404, 409, 412, 422)
  async recordCompletion(
    @Body() dto: RecordCompletionDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<TrainingRecordResponseDto> {
    // `employee_id` carries no cross-schema FK, matching every other module, so without this a typo
    // would become a record for somebody who does not exist.
    await this.employees.assertExist(dto.employeeId);
    return toRecordDto(await this.service.recordCompletion(dto, user));
  }

  @Get('records/:id')
  @RequirePermission('training.read')
  @ApiOperation({ summary: 'Get a training record' })
  @ApiOkResponse({ type: TrainingRecordResponseDto })
  @ApiCommonErrors(401, 403, 404)
  async getRecord(@Param('id', ParseUUIDPipe) id: string): Promise<TrainingRecordResponseDto> {
    // `getRecordWithEmployee`, not `getRecord`: this is a read path, and the one that names a person.
    return toRecordDto(await this.service.getRecordWithEmployee(id));
  }

  @Post('records/:id/verify')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('training.manage')
  @ApiOperation({
    summary: 'Attest that the evidence is genuine',
    description:
      'Once only — overwriting who attested and when would erase the one fact a competency audit ' +
      'reads.',
  })
  @ApiOkResponse({ type: TrainingRecordResponseDto })
  @ApiCommonErrors(401, 403, 404, 409, 412)
  async verifyRecord(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<TrainingRecordResponseDto> {
    return toRecordDto(await this.service.verifyRecord(id, user));
  }

  @Post('records/:id/revoke')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('training.manage')
  @ApiOperation({ summary: 'Revoke a record — evidence that turned out to be wrong' })
  @ApiOkResponse({ type: TrainingRecordResponseDto })
  @ApiCommonErrors(401, 403, 404, 409, 412, 422)
  async revokeRecord(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RevokeRecordDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<TrainingRecordResponseDto> {
    return toRecordDto(await this.service.revokeRecord(id, dto.reason, user));
  }

  @Get('employees/:employeeId/records')
  @RequirePermission('training.read')
  @ApiOperation({ summary: "One employee's training history, newest first" })
  @ApiOkResponse({ type: [TrainingRecordResponseDto] })
  @ApiCommonErrors(401, 403, 404)
  async employeeRecords(
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
  ): Promise<TrainingRecordResponseDto[]> {
    await this.employees.assertExist(employeeId);
    return (await this.service.listRecordsForEmployee(employeeId)).map(toRecordDto);
  }

  // ── Certificates ─────────────────────────────────────────────────────────────
  //
  // The endpoint shape is rally's: presign, confirm, list, download, delete. The mechanics live in
  // `EntityAttachmentsService`; these routes prove the record exists and decide who may act.

  @Get('records/:id/certificates')
  @AuthorizedInService(
    "the uploader may list their own record's certificates; anyone else needs training.manage",
    'training.e2e.spec.ts',
  )
  @ApiOperation({ summary: 'Certificates attached to a record' })
  @ApiOkResponse({ type: [CertificateResponseDto] })
  @ApiCommonErrors(401, 403, 404)
  async listCertificates(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<CertificateResponseDto[]> {
    await this.assertMayAttach(user, id);
    return (await this.service.listCertificates(id)).map(toCertificateDto);
  }

  // UPLOAD tier: a presign hands out a signed PUT and a confirm does a HeadObject, so both cost S3
  // requests rather than just database time. Assets carried this from the start; these three surfaces
  // did not, which meant the tier existed and two thirds of the uploads in the product ignored it.
  @RateLimit('UPLOAD')
  @Post('records/:id/certificates/presign')
  @AuthorizedInService(
    'an employee may attach evidence to their OWN record; anyone else needs training.manage',
    'training.e2e.spec.ts',
  )
  @ApiOperation({
    summary: 'Get a presigned PUT URL for a certificate',
    description:
      'PUT the bytes to `uploadUrl` within 5 minutes, then call confirm. The MIME allow-list, the ' +
      'size ceiling and the per-record quota come from the `training-certificate` policy.',
  })
  @ApiCreatedResponse({ type: PresignCertificateResponseDto })
  @ApiCommonErrors(401, 403, 404, 412, 422)
  async presignCertificate(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PresignCertificateDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<PresignCertificateResponseDto> {
    await this.assertMayAttach(user, id);
    return this.service.presignCertificate(id, dto, user);
  }

  @RateLimit('UPLOAD')
  @Post('records/:id/certificates/:fileId/confirm')
  @HttpCode(HttpStatus.OK)
  @AuthorizedInService(
    'an employee may attach evidence to their OWN record; anyone else needs training.manage',
    'training.e2e.spec.ts',
  )
  @ApiOperation({
    summary: 'Confirm the upload landed — attaches the certificate',
    description:
      'Verifies size and, where the backend reports one, checksum. The quota is re-checked here ' +
      'because this is the point the file becomes visible.',
  })
  @ApiOkResponse({ type: CertificateResponseDto })
  @ApiCommonErrors(401, 403, 404, 412)
  async confirmCertificate(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('fileId', ParseUUIDPipe) fileId: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<CertificateResponseDto> {
    await this.assertMayAttach(user, id);
    return toCertificateDto(await this.service.confirmCertificate(id, fileId, user));
  }

  @Get('records/:id/certificates/:fileId/download')
  @AuthorizedInService(
    'an employee may download evidence on their OWN record; anyone else needs training.manage',
    'training.e2e.spec.ts',
  )
  @ApiOperation({
    summary: 'Time-limited download URL for a certificate',
    description:
      'The file must be attached to THIS record — the id is a capability, so the ownership check ' +
      'is the authorization.',
  })
  @ApiOkResponse({ type: DownloadUrlResponseDto })
  @ApiCommonErrors(401, 403, 404)
  async downloadCertificate(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('fileId', ParseUUIDPipe) fileId: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<DownloadUrlResponseDto> {
    await this.assertMayAttach(user, id);
    return { url: await this.service.certificateDownloadUrl(id, fileId) };
  }

  @Delete('records/:id/certificates/:fileId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @AuthorizedInService(
    "the uploader may remove their own file; a training.manage holder may remove anyone's",
    'training.e2e.spec.ts',
  )
  @ApiOperation({ summary: 'Remove a certificate (uploader or training.manage)' })
  @ApiCommonErrors(401, 403, 404, 412)
  async removeCertificate(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('fileId', ParseUUIDPipe) fileId: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<void> {
    const manages = await this.assertMayAttach(user, id);
    await this.service.removeCertificate(id, fileId, user, manages);
  }

  // ── The report ───────────────────────────────────────────────────────────────

  @Get('gaps')
  @RequirePermission('training.read')
  @ApiOperation({
    summary: 'Competency gaps — who is missing training their CURRENT position requires',
    description:
      'Mandatory only unless `includeRecommended` is set. `reason` distinguishes ' +
      '`never_completed` from `expired`, because one needs scheduling and the other rescheduling.',
  })
  @ApiOkResponse({ type: [CompetencyGapResponseDto] })
  @ApiCommonErrors(401, 403)
  async gaps(@Query() query: CompetencyGapQueryDto): Promise<CompetencyGapResponseDto[]> {
    return (
      await this.service.competencyGaps({
        employeeId: query.employeeId,
        positionId: query.positionId,
        asOf: query.asOf,
        includeRecommended: query.includeRecommended,
      })
    ).map(toGapDto);
  }
}
