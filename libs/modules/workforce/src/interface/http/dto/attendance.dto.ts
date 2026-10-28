import { ApiProperty } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { justificationKindEnum, wfhStatusEnum } from '@db/schema/enums';

const dateStr = z.string().date();

/** `YYYY-MM` — same shape and bounds as the WIO calendar's month. */
export const monthStr = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'month must be YYYY-MM')
  .refine((m) => Number(m.slice(0, 4)) >= 2000 && Number(m.slice(0, 4)) <= 2100, {
    message: 'month must fall between 2000 and 2100',
  });

// ── The derived month ────────────────────────────────────────────────────────

export class AttendanceMonthQueryDto extends createZodDto(
  z.object({ month: monthStr, employeeId: z.string().uuid().optional() }),
) {}

export class MyAttendanceMonthQueryDto extends createZodDto(z.object({ month: monthStr })) {}

export class AttendanceDayDto {
  date!: string;
  @ApiProperty({ enum: ['holiday', 'leave', 'wfh', 'office', 'absent'] })
  status!: 'holiday' | 'leave' | 'wfh' | 'office' | 'absent';
  workedMinutes!: number;
  lateMinutes!: number | null;
  earlyMinutes!: number | null;
  /** The day's unresolved problems; an approved justification clears them. */
  @ApiProperty({ enum: ['late', 'early', 'missing_checkout', 'absent', 'unsynced'], isArray: true })
  flags!: ('late' | 'early' | 'missing_checkout' | 'absent' | 'unsynced')[];
  /** A justification has been filed for this day but not decided yet. */
  pendingJustification!: boolean;
  /** The approved leave type covering the day, when the status is `leave`. */
  leaveType!: string | null;
  /** Which part of the day approved leave takes, when any — halves count 0.5 in the sheets. */
  @ApiProperty({ enum: ['full_day', 'morning', 'afternoon'], nullable: true })
  leavePortion!: 'full_day' | 'morning' | 'afternoon' | null;
}

export class EmployeeAttendanceMonthDto {
  id!: string;
  name!: string;
  department!: string | null;
  /** Only working days: Mon–Fri minus the public holidays. */
  days!: AttendanceDayDto[];
}

export class MonthCloseDto {
  month!: string;
  closedBy!: string;
  closedAt!: string;
  note!: string | null;
}

export class AttendanceMonthResponseDto {
  month!: string;
  close!: MonthCloseDto | null;
  employees!: EmployeeAttendanceMonthDto[];
}

// ── Justifications ───────────────────────────────────────────────────────────

export const CreateJustificationSchema = z
  .object({
    startDate: dateStr,
    endDate: dateStr,
    kind: z.enum(justificationKindEnum.enumValues),
    reason: z.string().max(1000).optional(),
  })
  .refine((v) => v.startDate <= v.endDate, {
    message: 'startDate must be on or before endDate',
    path: ['endDate'],
  });
export class CreateJustificationDto extends createZodDto(CreateJustificationSchema) {}

export class JustificationPreviewQueryDto extends createZodDto(
  z.object({ startDate: dateStr, endDate: dateStr }).refine((v) => v.startDate <= v.endDate, {
    message: 'startDate must be on or before endDate',
    path: ['endDate'],
  }),
) {}

export class JustificationPreviewResponseDto {
  startDate!: string;
  endDate!: string;
  /** The working days in `[startDate, endDate]` — weekends and public holidays skipped. */
  workingDays!: string[];
}

export class ListJustificationsQueryDto extends createZodDto(
  z.object({
    employeeId: z.string().uuid().optional(),
    status: z.enum(wfhStatusEnum.enumValues).optional(),
  }),
) {}

export class JustificationResponseDto {
  id!: string;
  employeeId!: string;
  startDate!: string;
  endDate!: string;
  @ApiProperty({ enum: justificationKindEnum.enumValues })
  kind!: (typeof justificationKindEnum.enumValues)[number];
  reason!: string | null;
  /** Working days the window covers — always a whole number. */
  workingDays!: number;
  @ApiProperty({ enum: wfhStatusEnum.enumValues })
  status!: (typeof wfhStatusEnum.enumValues)[number];
  reviewerId!: string | null;
  reviewedAt!: string | null;
  createdAt!: string;
}

// ── Month close ──────────────────────────────────────────────────────────────

export class CloseMonthDto extends createZodDto(
  z.object({ note: z.string().max(500).optional() }),
) {}

/** Reopen is an override: the reason is REQUIRED, and it lands in the audit trail. */
export class ReopenMonthDto extends createZodDto(z.object({ note: z.string().min(1).max(500) })) {}

export class MonthCloseParamDto extends createZodDto(z.object({ month: monthStr })) {}
