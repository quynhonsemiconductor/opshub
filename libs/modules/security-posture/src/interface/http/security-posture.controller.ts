import { Controller, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import { ApiAcceptedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiCommonErrors, RequirePermission } from '@platform';
import { GRAPH_TASK, GraphTaskQueue } from '@modules/graph';
import { SecureScoreQueryService } from '../../application/secure-score-query.service';
import {
  BaselineQueryDto,
  BaselineResponseDto,
  ScoreHistoryQueryDto,
  ScoreHistoryResponseDto,
  SecureScoreResponseDto,
  SyncQueuedResponseDto,
} from './dto/security-posture.dto';

@ApiTags('security-posture')
@Controller('security-posture')
export class SecurityPostureController {
  constructor(
    private readonly scoreService: SecureScoreQueryService,
    private readonly graphTasks: GraphTaskQueue,
  ) {}

  @Get('score')
  @RequirePermission('security.view')
  @ApiOperation({ summary: 'Get current Secure Score and delta vs previous period' })
  @ApiOkResponse({ type: SecureScoreResponseDto })
  @ApiCommonErrors(401, 403)
  async getScore(): Promise<SecureScoreResponseDto> {
    const latest = await this.scoreService.getLatestScore();
    return { latest };
  }

  @Get('score/history')
  @RequirePermission('security.view')
  @ApiOperation({ summary: 'Secure Score trend data (up to 90 days)' })
  @ApiOkResponse({ type: ScoreHistoryResponseDto })
  @ApiCommonErrors(401, 403)
  async getScoreHistory(@Query() query: ScoreHistoryQueryDto): Promise<ScoreHistoryResponseDto> {
    const history = await this.scoreService.getScoreHistory(query.days);
    return { history, days: query.days };
  }

  @Get('baseline')
  @RequirePermission('security.view')
  @ApiOperation({ summary: 'List baseline drift checks, optionally filtered by category' })
  @ApiOkResponse({ type: BaselineResponseDto })
  @ApiCommonErrors(401, 403)
  async getBaseline(@Query() query: BaselineQueryDto): Promise<BaselineResponseDto> {
    const [checks, summary] = await Promise.all([
      this.scoreService.getBaselineChecks(query.category),
      this.scoreService.getBaselineSummary(),
    ]);
    return { checks, summary };
  }

  @Post('sync')
  @RequirePermission('security.manage')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Queue a security posture sync from Graph (the worker runs it; 202 Accepted)',
  })
  @ApiAcceptedResponse({ type: SyncQueuedResponseDto })
  @ApiCommonErrors(401, 403, 409)
  async triggerSync(): Promise<SyncQueuedResponseDto> {
    // 409 GRAPH_DISABLED when no worker can run it: a 202 would promise a sync that never happens.
    await this.graphTasks.requireGraphAvailable();
    // Enqueued, not run: the API holds no Graph credential. An equal sync already waiting covers this one.
    const queued = await this.graphTasks.enqueue({ kind: GRAPH_TASK.POSTURE_SYNC, payload: {} });
    return { queued };
  }
}
