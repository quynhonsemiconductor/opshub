import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ApiCommonErrors, Auth, CurrentUser, RequirePermission, type JwtPayload } from '@platform';
import { JobRanksService } from '../../application/job-ranks.service';
import type { JobRank, JobRankWithBenefits } from '../../domain/job-ranks.types';
import {
  CreateJobRankDto,
  JobRankResponseDto,
  SetRankBenefitsDto,
  UpdateJobRankDto,
} from './dto/job-ranks.dto';

/**
 * Maps a rank to its response shape.
 *
 * Args:
 *   rank: The rank, with or without its benefits.
 *
 * Returns:
 *   The response DTO; `benefits` is empty when the rank came without them.
 */
function toJobRankDto(rank: JobRank | JobRankWithBenefits): JobRankResponseDto {
  return {
    id: rank.id,
    ordinal: rank.ordinal,
    name: rank.name,
    benefits: 'benefits' in rank ? rank.benefits : [],
    createdAt: rank.createdAt.toISOString(),
    updatedAt: rank.updatedAt.toISOString(),
  };
}

@ApiTags('job-ranks')
@Controller('job-ranks')
@Auth()
export class JobRanksController {
  constructor(private readonly service: JobRanksService) {}

  @Get()
  @RequirePermission('position.read')
  @ApiOperation({
    summary: 'List job ranks with their benefits',
    description: 'Most junior first. A rank with no benefits carries an empty list.',
  })
  @ApiOkResponse({ type: [JobRankResponseDto] })
  @ApiCommonErrors(401, 403)
  async list(): Promise<JobRankResponseDto[]> {
    return (await this.service.listRanks()).map(toJobRankDto);
  }

  @Post()
  @RequirePermission('position.manage')
  @ApiOperation({ summary: 'Create a job rank' })
  @ApiCreatedResponse({ type: JobRankResponseDto })
  @ApiCommonErrors(401, 403, 409, 422)
  async create(
    @Body() dto: CreateJobRankDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<JobRankResponseDto> {
    return toJobRankDto(await this.service.createRank(dto, { sub: user.sub, email: user.email }));
  }

  @Patch(':id')
  @RequirePermission('position.manage')
  @ApiOperation({ summary: 'Rename a job rank or move it to another ordinal' })
  @ApiOkResponse({ type: JobRankResponseDto })
  @ApiCommonErrors(401, 403, 404, 409, 422)
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateJobRankDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<JobRankResponseDto> {
    return toJobRankDto(
      await this.service.updateRank(id, dto, { sub: user.sub, email: user.email }),
    );
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('position.manage')
  @ApiOperation({
    summary: 'Delete a job rank',
    description: 'Refused (409 `JOB_RANK_IN_USE`) while any position still carries the rank.',
  })
  @ApiNoContentResponse()
  @ApiCommonErrors(401, 403, 404, 409)
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<void> {
    await this.service.deleteRank(id, { sub: user.sub, email: user.email });
  }

  @Put(':id/benefits')
  @RequirePermission('position.manage')
  @ApiOperation({
    summary: 'Replace the benefits of a job rank',
    description:
      'The whole set at once: a benefit code left out is removed. `wfh_weekly_days` is the number of ' +
      'work-from-home days an employee of the rank may take in one Monday–Sunday week.',
  })
  @ApiOkResponse({ type: JobRankResponseDto })
  @ApiCommonErrors(401, 403, 404, 422)
  async setBenefits(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetRankBenefitsDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<JobRankResponseDto> {
    return toJobRankDto(
      await this.service.setRankBenefits(id, dto.benefits, { sub: user.sub, email: user.email }),
    );
  }
}
