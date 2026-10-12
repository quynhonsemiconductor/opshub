import { ApiExtraModels, ApiProperty, ApiPropertyOptional, getSchemaPath } from '@nestjs/swagger';
import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';

export const BaselineQuerySchema = z.object({
  category: z.enum(['asr', 'firewall', 'encryption', 'endpoint', 'identity', 'other']).optional(),
});

export class BaselineQueryDto extends createZodDto(BaselineQuerySchema) {}

export const ScoreHistoryQuerySchema = z.object({
  days: z.coerce.number().int().min(7).max(90).default(30),
});

export class ScoreHistoryQueryDto extends createZodDto(ScoreHistoryQuerySchema) {}

/*
 * RESPONSE DTOs.
 *
 * These three GETs had none — no `@ApiOkResponse`, so the OpenAPI document described their responses as
 * empty and `openapi-typescript` generated nothing for them. That is WHY the SPA hand-wrote four
 * interfaces for this screen: there was nothing to import. An undocumented response is not a private
 * one; it is one every client has to guess at, and the finops screen showed where guessing ends.
 *
 * Declared as classes with `@ApiProperty` rather than through zod, because these describe what the
 * service already returns — there is nothing to parse or validate on the way out.
 */

export class ScoreLatestDto {
  @ApiProperty({ description: 'Points achieved, as the Graph API reports them.' })
  score!: string;

  @ApiProperty({ description: 'Points available.' })
  maxScore!: string;

  @ApiProperty({ description: 'Achieved as a percentage of available.' })
  percentageScore!: string;

  @ApiProperty({ description: 'The day this snapshot describes.' })
  scoreDate!: string;
}

export class SecureScoreResponseDto {
  @ApiProperty({
    type: ScoreLatestDto,
    nullable: true,
    description: 'Null until the first sync has run — which is a state the UI has to render.',
  })
  latest!: ScoreLatestDto | null;
}

export class ScoreHistoryPointDto {
  @ApiProperty()
  scoreDate!: string;

  @ApiProperty()
  percentageScore!: string;
}

export class ScoreHistoryResponseDto {
  @ApiProperty({ type: [ScoreHistoryPointDto] })
  history!: ScoreHistoryPointDto[];

  @ApiProperty({ description: 'The window that was asked for, echoed back.' })
  days!: number;
}

export class BaselineCheckDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ description: 'asr | firewall | encryption | endpoint | identity | other' })
  category!: string;

  @ApiProperty()
  checkName!: string;

  @ApiProperty({ description: 'pass | fail | warning' })
  status!: string;

  @ApiPropertyOptional({ nullable: true })
  expectedValue!: string | null;

  @ApiPropertyOptional({ nullable: true })
  actualValue!: string | null;

  @ApiPropertyOptional({ nullable: true })
  details!: string | null;
}

export class BaselineCategorySummaryDto {
  @ApiProperty()
  pass!: number;

  @ApiProperty()
  fail!: number;

  @ApiProperty()
  warning!: number;

  @ApiProperty()
  total!: number;
}

@ApiExtraModels(BaselineCategorySummaryDto)
export class BaselineResponseDto {
  @ApiProperty({ type: [BaselineCheckDto] })
  checks!: BaselineCheckDto[];

  /*
   * A MAP keyed by category, so the value schema has to be `$ref`'d explicitly.
   *
   * `additionalProperties: { type: 'object' }` — which is what this said first — generates
   * `Record<string, {}>`, and every field access on it is a type error at the client. The `$ref` plus
   * `@ApiExtraModels` (the summary type appears nowhere else, so Swagger would not otherwise emit it)
   * is what makes the generated type usable.
   */
  @ApiProperty({
    type: 'object',
    additionalProperties: { $ref: getSchemaPath(BaselineCategorySummaryDto) },
    description: 'Keyed by category. A category with no checks is absent rather than zeroed.',
  })
  summary!: Record<string, BaselineCategorySummaryDto>;
}

export class SyncQueuedResponseDto {
  @ApiProperty({
    description:
      'True when a new sync task was queued; false when one was already waiting, which covers this request.',
  })
  queued!: boolean;
}
