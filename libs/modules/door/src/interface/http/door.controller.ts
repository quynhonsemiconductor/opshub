import {
  Body,
  Controller,
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
  buildPageResult,
  CurrentUser,
  RateLimit,
  RequirePermission,
} from '@platform';
import type { JwtPayload, PagedResult } from '@platform';
import { DoorService } from '../../application/door.service';
import type { DoorTerminal, DoorCard, UnknownCardEvent } from '../../domain/door.types';
import {
  CreateTerminalDto,
  CreateCardDto,
  UpdateCardDto,
  ListCardsQueryDto,
  DoorTerminalResponseDto,
  DoorTerminalTokenResponseDto,
  DoorCardResponseDto,
  UnknownCardEventResponseDto,
} from './dto/door.dto';

function toTerminalDto(t: DoorTerminal): DoorTerminalResponseDto {
  return {
    id: t.id,
    name: t.name,
    location: t.location,
    lastSeenAt: t.lastSeenAt ? t.lastSeenAt.toISOString() : null,
    revokedAt: t.revokedAt ? t.revokedAt.toISOString() : null,
    droppedEvents: t.droppedEvents,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

function toCardDto(c: DoorCard & { employeeName?: string | null }): DoorCardResponseDto {
  return {
    id: c.id,
    employeeId: c.employeeId,
    // Resolved on the list read, absent on the write — one DTO, nullable rather than a forked shape.
    employeeName: c.employeeName ?? null,
    uid: c.uid,
    label: c.label,
    status: c.status,
    validFrom: c.validFrom.toISOString(),
    validUntil: c.validUntil ? c.validUntil.toISOString() : null,
    revokedAt: c.revokedAt ? c.revokedAt.toISOString() : null,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

function toUnknownEventDto(e: UnknownCardEvent): UnknownCardEventResponseDto {
  return {
    id: e.id,
    terminalId: e.terminalId,
    uid: e.uid,
    result: e.result,
    deviceTs: e.deviceTs.toISOString(),
    receivedAt: e.receivedAt.toISOString(),
  };
}

/**
 * The admin side of the door (HR / IT): terminals and cards. The TERMINAL side (the routes the ESP32
 * calls) lives in the same module under `/v1/door/terminal/*` and authenticates with a bearer token,
 * not a session — see the terminal controller for why.
 */
@ApiTags('door')
@Controller('door')
export class DoorController {
  constructor(private readonly door: DoorService) {}

  @Get('terminals')
  @RequirePermission('door.read')
  @RateLimit('STRICT')
  @ApiOperation({ summary: 'List door terminals' })
  @ApiOkResponse({ type: [DoorTerminalResponseDto] })
  @ApiCommonErrors(401, 403)
  async listTerminals(): Promise<DoorTerminalResponseDto[]> {
    return (await this.door.listTerminals()).map(toTerminalDto);
  }

  @Post('terminals')
  @RequirePermission('door.manage')
  @RateLimit('STRICT')
  @ApiOperation({
    summary: 'Register a terminal — the bearer token is returned ONCE and never stored in clear',
  })
  @ApiCreatedResponse({ type: DoorTerminalTokenResponseDto })
  @ApiCommonErrors(401, 403, 409, 422)
  async createTerminal(
    @Body() dto: CreateTerminalDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<DoorTerminalTokenResponseDto> {
    const { terminal, token } = await this.door.createTerminal(dto, {
      sub: user.sub,
      email: user.email,
    });
    return { terminal: toTerminalDto(terminal), token };
  }

  @Post('terminals/:id/token')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('door.manage', { resource: 'door_terminal', from: 'param', field: 'id' })
  @RateLimit('STRICT')
  @ApiOperation({
    summary: 'Regenerate a terminal token — the old token stops working immediately',
  })
  @ApiOkResponse({ type: DoorTerminalTokenResponseDto })
  @ApiCommonErrors(401, 403, 404, 409, 412, 422)
  async regenerateTerminalToken(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<DoorTerminalTokenResponseDto> {
    const { terminal, token } = await this.door.regenerateTerminalToken(id, {
      sub: user.sub,
      email: user.email,
    });
    return { terminal: toTerminalDto(terminal), token };
  }

  @Post('terminals/:id/revoke')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('door.manage', { resource: 'door_terminal', from: 'param', field: 'id' })
  @RateLimit('STRICT')
  @ApiOperation({ summary: 'Revoke a terminal — it can no longer authenticate (idempotent)' })
  @ApiOkResponse({ type: DoorTerminalResponseDto })
  @ApiCommonErrors(401, 403, 404, 409, 422)
  async revokeTerminal(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<DoorTerminalResponseDto> {
    return toTerminalDto(await this.door.revokeTerminal(id, { sub: user.sub, email: user.email }));
  }

  @Get('cards')
  @RequirePermission('door.read')
  @RateLimit('STRICT')
  @ApiOperation({ summary: 'List door cards' })
  @ApiPagedResponse(DoorCardResponseDto)
  @ApiCommonErrors(401, 403)
  async listCards(@Query() query: ListCardsQueryDto): Promise<PagedResult<DoorCardResponseDto>> {
    const { rows, total } = await this.door.listCards(
      { status: query.status, employeeId: query.employeeId },
      query.limit,
      query.offset,
    );
    return buildPageResult(rows.map(toCardDto), total, query.limit, query.offset);
  }

  @Post('cards')
  @RequirePermission('door.manage')
  @RateLimit('STRICT')
  @ApiOperation({ summary: 'Enrol a card for an employee' })
  @ApiCreatedResponse({ type: DoorCardResponseDto })
  @ApiCommonErrors(401, 403, 404, 409, 422)
  async createCard(
    @Body() dto: CreateCardDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<DoorCardResponseDto> {
    const card = await this.door.addCard(
      {
        ...dto,
        validFrom: dto.validFrom ? new Date(dto.validFrom) : undefined,
        validUntil: dto.validUntil ? new Date(dto.validUntil) : null,
      },
      { sub: user.sub, email: user.email },
    );
    return toCardDto({ ...card, employeeName: null });
  }

  @Patch('cards/:id')
  @RequirePermission('door.manage', { resource: 'door_card', from: 'param', field: 'id' })
  @RateLimit('STRICT')
  @ApiOperation({ summary: 'Label a card, set its window, revoke it or mark it lost' })
  @ApiOkResponse({ type: DoorCardResponseDto })
  @ApiCommonErrors(401, 403, 404, 409, 422)
  async updateCard(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCardDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<DoorCardResponseDto> {
    const card = await this.door.updateCard(
      id,
      {
        ...dto,
        validFrom: dto.validFrom ? new Date(dto.validFrom) : undefined,
        validUntil:
          dto.validUntil !== undefined
            ? dto.validUntil
              ? new Date(dto.validUntil)
              : null
            : undefined,
      },
      { sub: user.sub, email: user.email },
    );
    return toCardDto({ ...card, employeeName: null });
  }

  @Get('unknown-cards')
  @RequirePermission('door.read')
  @RateLimit('STRICT')
  @ApiOperation({
    summary: 'UIDs the readers saw in the last 24 h that belonged to nobody — the enrolment list',
  })
  @ApiOkResponse({ type: [UnknownCardEventResponseDto] })
  @ApiCommonErrors(401, 403)
  async unknownCards(): Promise<UnknownCardEventResponseDto[]> {
    return (await this.door.unknownCards()).map(toUnknownEventDto);
  }
}
