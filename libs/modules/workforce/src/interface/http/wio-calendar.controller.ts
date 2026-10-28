import { Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiCommonErrors, Auth, SharedRead } from '@platform';
import { WioCalendarService } from '../../application/wio-calendar.service';
import { WioMonthQueryDto, WioMonthResponseDto } from './dto/wio-calendar.dto';

/**
 * Read-only since the move to manager-approved WFH requests (owner rules 2026-10-28): the only write
 * path is `POST /workforce/wfh` and its review, on the request engine like leave.
 */
@ApiTags('workforce')
@Controller('workforce/wio-calendar')
@Auth()
export class WioCalendarController {
  constructor(private readonly service: WioCalendarService) {}

  @Get()
  @SharedRead(
    'the calendar exists so everyone sees who is in the office; it returns names, departments, ' +
      'work-from-home dates and holidays only, never hours or leave',
  )
  @ApiOperation({
    summary: 'Who works from home, for one month',
    description:
      "Returns everyone the calendar accounts for, the month's work-from-home marks (from live " +
      "requests, pending shown as pending), the month's approved leave on working days, and the " +
      "month's public holidays. A day with no mark is a day in the office.",
  })
  @ApiOkResponse({ type: WioMonthResponseDto })
  @ApiCommonErrors(401, 422)
  async getMonth(@Query() query: WioMonthQueryDto): Promise<WioMonthResponseDto> {
    return this.service.getMonth(query.month);
  }
}
