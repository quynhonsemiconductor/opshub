import { ApiProperty } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { PaginationQuerySchema } from '@shared-kernel';
import { softwareListingEnum, findingSeverityEnum, findingStatusEnum } from '@db/schema/enums';

const listing = z.enum(softwareListingEnum.enumValues);
const severity = z.enum(findingSeverityEnum.enumValues);
const findingStatus = z.enum(findingStatusEnum.enumValues);

export const AddSoftwareSchema = z.object({
  name: z.string().min(1).max(200),
  publisher: z.string().max(200).optional(),
  listing: listing.default('review'),
  notes: z.string().max(2000).optional(),
});

export class AddSoftwareDto extends createZodDto(AddSoftwareSchema) {}

export const UpdateSoftwareSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  publisher: z.string().max(200).nullable().optional(),
  listing: listing.optional(),
  notes: z.string().max(2000).nullable().optional(),
});

export class UpdateSoftwareDto extends createZodDto(UpdateSoftwareSchema) {}

export const ListSoftwareQuerySchema = z
  .object({
    listing: listing.optional(),
    search: z.string().max(200).optional(),
  })
  .merge(PaginationQuerySchema);

export class ListSoftwareQueryDto extends createZodDto(ListSoftwareQuerySchema) {}

export const ListFindingsQuerySchema = z
  .object({
    status: findingStatus.optional(),
    severity: severity.optional(),
    assetId: z.string().uuid().optional(),
    employeeId: z.string().uuid().optional(),
  })
  .merge(PaginationQuerySchema);

export class ListFindingsQueryDto extends createZodDto(ListFindingsQuerySchema) {}

export const ResolveFindingSchema = z.object({
  note: z.string().max(1000).optional(),
  riskAccepted: z.boolean().default(false),
});

export class ResolveFindingDto extends createZodDto(ResolveFindingSchema) {}

export class SoftwareResponseDto {
  id!: string;
  name!: string;
  publisher!: string | null;
  @ApiProperty({ enum: softwareListingEnum.enumValues })
  listing!: (typeof softwareListingEnum.enumValues)[number];
  notes!: string | null;
  createdAt!: string;
  updatedAt!: string;
}

export class FindingResponseDto {
  id!: string;
  assetId!: string | null;
  employeeId!: string | null;
  softwareName!: string;
  softwareVersion!: string | null;
  @ApiProperty({ enum: findingSeverityEnum.enumValues })
  severity!: (typeof findingSeverityEnum.enumValues)[number];
  @ApiProperty({ enum: findingStatusEnum.enumValues })
  status!: (typeof findingStatusEnum.enumValues)[number];
  source!: string;
  detectedAt!: string;
  resolvedBy!: string | null;
  resolutionNote!: string | null;
  resolvedAt!: string | null;
}

/**
 * The Shadow IT list and scan responses.
 *
 * WHY THEY EXIST NOW. Both routes returned an untyped object literal, so the OpenAPI document carried no
 * schema for them and the generated client typed them as `unknown` — which is why the only consumer of
 * `/shadow-it` was, until now, nothing. A response nobody can type is a response nobody can use.
 */
export class ShadowItListResponseDto {
  findings!: FindingResponseDto[];
  /** The number returned, which is capped — not the number that exists. */
  total!: number;
}

export class ShadowItScanQueuedDto {
  /** True when a new scan was queued; false when one was already waiting, which covers this request. */
  queued!: boolean;
}
