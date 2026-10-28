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

export class WioPersonDto {
  id!: string;
  name!: string;
  department!: string | null;
}

export class WioWfhDto {
  employeeId!: string;
  date!: string;
  /**
   * `approved` = a manager signed off; `pending` = asked, not yet answered. A rejected or cancelled
   * request leaves no mark at all.
   */
  status!: 'approved' | 'pending';
}

export class WioPtoDto {
  employeeId!: string;
  date!: string;
  /** `full_day` for a whole day; `morning` or `afternoon` when only part of the day is leave. */
  @ApiProperty({ enum: leaveDayPortionEnum.enumValues })
  portion!: (typeof leaveDayPortionEnum.enumValues)[number];
}

export class WioHolidayDto {
  date!: string;
  name!: string;
}

export class WioMonthResponseDto {
  month!: string;
  /** Everyone the calendar accounts for — a day's office list is these people minus that day's marks. */
  people!: WioPersonDto[];
  /** Only work-from-home days, from live requests. Absence is the default, so a day with no mark means in the office. */
  wfh!: WioWfhDto[];
  /**
   * Approved leave on working days, any type. The TYPE and the reason are deliberately absent: the calendar
   * says someone is away, never why (sick and parental leave are nobody else's business).
   */
  pto!: WioPtoDto[];
  /** The month's public holidays, name included, so the calendar can say why a day has nobody in. */
  holidays!: WioHolidayDto[];
}
