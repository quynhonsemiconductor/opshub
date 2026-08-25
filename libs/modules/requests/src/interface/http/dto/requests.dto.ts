import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PAGE_SIZE } from '@shared-kernel';

export const ListRequestsQuerySchema = z.object({
  type: z.string().optional(),
  status: z
    .enum(['pending', 'in_review', 'approved', 'rejected', 'cancelled', 'expired'])
    .optional(),
  requesterId: z.string().uuid().optional(),
  myQueue: z.preprocess((v) => v === 'true' || v === true, z.boolean()).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(PAGE_SIZE.NOTIFICATION_DEFAULT),
  offset: z.coerce.number().int().min(0).default(0),
});

export class ListRequestsQueryDto extends createZodDto(ListRequestsQuerySchema) {}

export const ReviewRequestSchema = z.object({
  note: z.string().max(1000).optional(),
});

export class ReviewRequestDto extends createZodDto(ReviewRequestSchema) {}

export const AddCommentSchema = z.object({
  body: z.string().min(1).max(5000),
});

export class AddCommentDto extends createZodDto(AddCommentSchema) {}

export class RequestCommentResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() requestId!: string;
  @ApiProperty() authorId!: string;
  @ApiProperty() body!: string;
  @ApiPropertyOptional({ nullable: true }) editedAt!: string | null;
  @ApiProperty() createdAt!: string;
}

export class RequestApprovalResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() requestId!: string;
  @ApiProperty() step!: number;
  @ApiProperty() approverId!: string;
  @ApiPropertyOptional({
    nullable: true,
    description:
      'The approver\u2019s display name, resolved server-side. Null when the employee row is ' +
      'gone: a decision outlives the person who made it, and a departed approver\u2019s is the ' +
      'one an access review comes back to. Sent because the approval chain is the audit trail ' +
      'of the decision, so a row showing only a uuid cannot say who said yes.',
  })
  approverName!: string | null;
  @ApiProperty() decision!: string;
  @ApiPropertyOptional({ nullable: true }) note!: string | null;
  @ApiPropertyOptional({
    nullable: true,
    description: 'Set when approver was acting as delegate for this user',
  })
  delegatedFromId!: string | null;
  @ApiProperty() decidedAt!: string;
}

export class RequestItemResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() type!: string;
  @ApiProperty() requesterId!: string;
  @ApiPropertyOptional({
    nullable: true,
    description:
      'The requester\u2019s display name, resolved server-side. Null when the employee row is gone — a ' +
      'request outlives the person who filed it. Sent because an approval queue showing a uuid does ' +
      'not say who is asking.',
  })
  requesterName!: string | null;
  @ApiPropertyOptional({ nullable: true }) assigneeId!: string | null;
  @ApiPropertyOptional({
    nullable: true,
    description:
      'The current assignee\u2019s display name, resolved server-side. Null in two cases the ' +
      'caller renders the same way: the request has no assignee at all — normal while pending, ' +
      'since any holder of the step\u2019s permission may decide it — or the assignee\u2019s employee ' +
      'row is gone. Sent because the assignee is who a pending request is WAITING ON, which a ' +
      'uuid does not say; assigneeId still tells the two null cases apart.',
  })
  assigneeName!: string | null;
  @ApiProperty() status!: string;
  @ApiProperty() priority!: string;
  @ApiProperty() payload!: Record<string, unknown>;
  @ApiPropertyOptional({ nullable: true }) resolutionNote!: string | null;
  @ApiProperty() submittedAt!: string;
  @ApiPropertyOptional({ nullable: true }) resolvedAt!: string | null;
  @ApiPropertyOptional({ nullable: true }) expiresAt!: string | null;
  @ApiPropertyOptional({ nullable: true, description: 'SLA threshold hours for this request type' })
  slaHours!: number | null;
  @ApiPropertyOptional({ nullable: true, description: 'Absolute SLA deadline' })
  slaDeadline!: string | null;
  @ApiPropertyOptional({ nullable: true, description: 'When SLA breach was first detected' })
  slaBreachedAt!: string | null;
  @ApiProperty({
    description: 'Current approval step (1-based). Increments as each step is approved.',
  })
  currentStep!: number;
  @ApiProperty({ description: 'Total approval steps required (from TypeDef). 1 = single-step.' })
  totalSteps!: number;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
  @ApiPropertyOptional({ type: [RequestApprovalResponseDto] })
  approvals!: RequestApprovalResponseDto[];
}
