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
    // `stream` is the batch's IDENTITY (the terminal_id/stream/seq idempotency key) and a uuid
    // column, so it stays strict: without it the batch cannot be deduped at all. Everything
    // ADVISORY below is parsed in the service instead — telemetry must never refuse the batch.
    stream: z.string().uuid(),
    // Bench 2026-10-31: a `battery_mv` of 33924 (an unwired divider) made every batch a 422, and
    // the terminal kept it and retried forever, taking every tap event with it. `dropped` was
    // the same trap at both ends of its range. The envelope now accepts any JSON value for the
    // telemetry and the service decides what is usable (see DoorService.ingestEvents); a
    // per-event failure is still strict and named in `rejected`.
    dropped: z.unknown().optional(),
    battery_mv: z.unknown().optional(),
    low_battery: z.unknown().optional(),
    // ANY item, not just objects: one malformed event is ONE rejected seq (the service's
    // per-event path), never a 422 for the whole batch.
    events: z.array(z.unknown()).optional().default([]),
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
      dropped?: unknown;
      battery_mv?: unknown;
      low_battery?: unknown;
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
