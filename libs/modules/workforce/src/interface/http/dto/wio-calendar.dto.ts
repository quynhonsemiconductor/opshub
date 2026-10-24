import { ApiProperty } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { leaveDayPortionEnum } from '@db/schema/enums';

// ── WIO calendar ─────────────────────────────────────────────────────────────

export const WioMonthQuerySchema = z.object({
  /** `YYYY-MM`. A month is the unit because it is what the calendar draws and what one query can answer. */
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'month must be YYYY-MM')
    // `Date.UTC` reads years 0 to 99 as 19xx and Postgres refuses year 0, so a wild year is refused here.
    .refine((m) => Number(m.slice(0, 4)) >= 2000 && Number(m.slice(0, 4)) <= 2100, {
      message: 'month must fall between 2000 and 2100',
    }),
});
export class WioMonthQueryDto extends createZodDto(WioMonthQuerySchema) {}

export const WioDayParamSchema = z.object({
  date: z.string().date(),
});
export class WioDayParamDto extends createZodDto(WioDayParamSchema) {}

export const SetWioDaySchema = z.object({
  /** True = working from home that day; false = back to the office, which is the default. */
  wfh: z.boolean(),
});
export class SetWioDayDto extends createZodDto(SetWioDaySchema) {}

export class WioPersonDto {
  id!: string;
  name!: string;
  department!: string | null;
}

export class WioMarkDto {
  employeeId!: string;
  date!: string;
}

export class WioPtoDto {
  employeeId!: string;
  date!: string;
  /** `full_day` for a whole day; `morning` or `afternoon` when only part of the day is leave. */
  @ApiProperty({ enum: leaveDayPortionEnum.enumValues })
  portion!: (typeof leaveDayPortionEnum.enumValues)[number];
}

export class WioMonthResponseDto {
  month!: string;
  /** Everyone the calendar accounts for — a day's office list is these people minus that day's marks. */
  people!: WioPersonDto[];
  /** Only the work-from-home days. Absence is the default, so a day with no mark means in the office. */
  wfh!: WioMarkDto[];
  /**
   * Approved leave on working days, any type. The TYPE and the reason are deliberately absent: the calendar
   * says someone is away, never why (sick and parental leave are nobody else's business).
   */
  pto!: WioPtoDto[];
}

export class WioDayResponseDto {
  date!: string;
  wfh!: boolean;
}
