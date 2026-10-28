import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { createHash } from 'node:crypto';
import { ApiCommonErrors, ErrorCodes, Public, ValidationException } from '@platform';
import { z } from 'zod';
import { DoorService, type IngestEvent } from '../../application/door.service';
import { TerminalAuthGuard, type DoorTerminalRequest } from './terminal-auth.guard';

/**
 * NOT strict on purpose (ADR §2.4): fields may be ADDED to the contract, so unknown fields pass.
 * Anything breaking goes to a new path version. Strictness happens PER EVENT in the service — the
 * envelope is loose, the events are not.
 */
const EventsEnvelopeSchema = z
  .object({
    stream: z.string().uuid(),
    dropped: z.number().int().min(0).max(100_000).default(0),
    // Batch-level battery telemetry (one pack per controller). Optional for firmware roll-in;
    // the service persists the latest reading to the cache for the terminals badge.
    battery_mv: z.number().int().min(0).max(20_000).optional(),
    low_battery: z.boolean().optional(),
    events: z.array(z.record(z.string(), z.unknown())).max(100),
  })
  .loose();

/**
 * The routes the ESP32 terminal calls (contract v1, ADR §2.4). The contract is PUBLIC knowledge —
 * it lives in `docs/contracts/door-terminal-v1/` and the firmware repo copies it; the token is the
 * secret.
 *
 * WHY `@Public()`: these routes carry no identity session — the caller is a machine with a bearer
 * token, and identity's globally-registered `SessionGuard` would refuse any request without a
 * cookie. `@Public()` (which also sets identity's own public marker) satisfies the route ratchet
 * and the boot-time route-authz-audit; `TerminalAuthGuard` then does the whole of the
 * authorization, and `PolicyGuard` never runs. No cookie is sent, so the CSRF gate does not apply
 * and no exemption was added.
 */
@ApiTags('door-terminal')
@Controller('door/terminal')
@UseGuards(TerminalAuthGuard)
export class DoorTerminalController {
  constructor(private readonly door: DoorService) {}

  @Get('allow-list')
  @Public()
  @ApiOperation({ summary: 'The full card allow-list; ETag/304 — the terminal polls every 60 min' })
  @ApiCommonErrors(401)
  async allowList(
    @Req() request: DoorTerminalRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Headers('if-none-match') ifNoneMatch?: string,
  ): Promise<unknown> {
    const cards = await this.door.allowList();
    const body = JSON.stringify({ cards });
    // The ETag IS the answer's identity: a strong hash of the exact body, so any change to the
    // list — and nothing else — changes it (ADR §2.4).
    const etag = `"${createHash('sha256').update(body).digest('hex')}"`;
    // no-store: the 60 s poll IS the freshness mechanism; no cache anywhere may hold a copy.
    reply.header('ETag', etag);
    reply.header('Cache-Control', 'no-store');
    if (ifNoneMatch && matches(ifNoneMatch, etag)) {
      // 304 MUST carry no body — a body on a 304 is a spec violation some caches punish.
      reply.code(304);
      return;
    }
    return JSON.parse(body);
  }

  @Post('events')
  @HttpCode(HttpStatus.OK)
  @Public()
  @ApiOperation({ summary: 'Upload a batch of buffered door events (idempotent per stream/seq)' })
  @ApiCommonErrors(401)
  async events(
    @Req() request: DoorTerminalRequest,
    @Body() body: unknown,
  ): Promise<{
    acked_through: number;
    rejected: number[];
  }> {
    const terminal = request.doorTerminal;
    if (!terminal) throw new Error('TerminalAuthGuard must run before DoorTerminalController');
    const parsed = EventsEnvelopeSchema.safeParse(body);
    if (!parsed.success) {
      // A malformed ENVELOPE (not a malformed event) can name no seq to reject — the whole batch
      // is refused (422, the house validation failure) and the terminal retries it as-is.
      throw new ValidationException(ErrorCodes.VALIDATION_FAILED, 'Invalid event envelope');
    }
    const envelope = parsed.data as unknown as {
      stream: string;
      dropped: number;
      battery_mv?: number;
      low_battery?: boolean;
      events: IngestEvent[];
    };
    return this.door.ingestEvents(terminal.id, envelope).then((r) => ({
      acked_through: r.ackedThrough,
      rejected: r.rejected,
    }));
  }
}

/** Cloudflare compresses and weakens ETags (`W/"…"`); the comparison ignores that prefix. */
function matches(ifNoneMatch: string, etag: string): boolean {
  const normalise = (v: string) => v.trim().replace(/^W\//, '');
  return ifNoneMatch.split(',').some((candidate) => {
    const c = normalise(candidate);
    return c === normalise(etag) || c === '*';
  });
}
