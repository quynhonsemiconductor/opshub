import { Body, Controller, Get, HttpCode, Param, Put, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiCommonErrors, Auth, CurrentUser, SelfScoped, SharedRead } from '@platform';
import type { JwtPayload } from '@platform';
import { WioCalendarService } from '../../application/wio-calendar.service';
import {
  SetWioDayDto,
  WioDayParamDto,
  WioDayResponseDto,
  WioMonthQueryDto,
  WioMonthResponseDto,
} from './dto/wio-calendar.dto';

@ApiTags('workforce')
@Controller('workforce/wio-calendar')
@Auth()
export class WioCalendarController {
  constructor(private readonly service: WioCalendarService) {}

  @Get()
  @SharedRead(
    'the calendar exists so everyone sees who is in the office; it returns names, departments and ' +
      'work-from-home dates only, never hours or leave',
  )
  @ApiOperation({
    summary: 'Who works from home, for one month',
    description:
      'Returns everyone the calendar accounts for and the work-from-home marks in the month. A day ' +
      'with no mark is a day in the office.',
  })
  @ApiOkResponse({ type: WioMonthResponseDto })
  @ApiCommonErrors(401, 422)
  async getMonth(@Query() query: WioMonthQueryDto): Promise<WioMonthResponseDto> {
    return this.service.getMonth(query.month);
  }

  @Put(':date')
  @HttpCode(200)
  @SelfScoped(
    "sets the CALLER's own work-from-home flag — the employee is actor.sub, never a parameter",
  )
  @ApiOperation({
    summary: 'Mark a day as work-from-home, or back to the office, for the current user',
    description: 'Idempotent. Refused for a day that has already passed and for a weekend.',
  })
  @ApiOkResponse({ type: WioDayResponseDto })
  @ApiCommonErrors(401, 412, 422)
  async setDay(
    @Param() params: WioDayParamDto,
    @Body() dto: SetWioDayDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<WioDayResponseDto> {
    return this.service.setDay(params.date, dto.wfh, user);
  }
}
