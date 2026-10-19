import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Auth, ApiCommonErrors, RequirePermission } from '@platform';
import { ReportsService } from '../../application/reports.service';
import {
  DateRangeQueryDto,
  DateRangeOnlyQueryDto,
  RequestSummaryResponseDto,
  CycleTimeResponseDto,
  SlaComplianceResponseDto,
  QueueDepthResponseDto,
  ThroughputResponseDto,
  FindingsSummaryResponseDto,
  AssetUtilizationResponseDto,
  LeaveSummaryResponseDto,
  OvertimeSummaryResponseDto,
} from './dto/reports.dto';

@ApiTags('reports')
@Controller('reports')
@Auth()
@RequirePermission('reports.read')
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  // ─── Requests ──────────────────────────────────────────────────────────────

  @Get('requests/summary')
  @ApiOperation({
    summary: 'Request counts by type and status',
    description:
      'Returns total request counts grouped by type and status. Useful for dashboards and status breakdowns.',
  })
  @ApiQuery({
    name: 'from',
    required: false,
    type: String,
    description: 'ISO-8601 start. Defaults to 30 days ago.',
  })
  @ApiQuery({
    name: 'to',
    required: false,
    type: String,
    description: 'ISO-8601 end. Defaults to now.',
  })
  @ApiQuery({
    name: 'type',
    required: false,
    type: String,
    description: 'Filter to a specific request type.',
  })
  @ApiResponse({ status: 200, type: RequestSummaryResponseDto })
  @ApiCommonErrors(401, 403)
  async getRequestSummary(@Query() query: DateRangeQueryDto): Promise<RequestSummaryResponseDto> {
    const { from, to } = await this.reportsService.resolveRange(query.from, query.to);
    const rows = await this.reportsService.getRequestSummary({ from, to, type: query.type });
    return { from: from.toISOString(), to: to.toISOString(), rows };
  }

  @Get('requests/cycle-time')
  @ApiOperation({
    summary: 'Request cycle time (avg / P50 / P90)',
    description:
      'Average, median (P50), and 90th-percentile (P90) time in hours from submission to resolution, grouped by request type.',
  })
  @ApiQuery({ name: 'from', required: false, type: String })
  @ApiQuery({ name: 'to', required: false, type: String })
  @ApiQuery({ name: 'type', required: false, type: String })
  @ApiResponse({ status: 200, type: CycleTimeResponseDto })
  @ApiCommonErrors(401, 403)
  async getRequestCycleTime(@Query() query: DateRangeQueryDto): Promise<CycleTimeResponseDto> {
    const { from, to } = await this.reportsService.resolveRange(query.from, query.to);
    const rows = await this.reportsService.getRequestCycleTime({ from, to, type: query.type });
    return { from: from.toISOString(), to: to.toISOString(), rows };
  }

  @Get('requests/sla-compliance')
  @ApiOperation({
    summary: 'SLA compliance rate by request type',
    description:
      'For requests with an SLA set: total, resolved within SLA, breached, and compliance rate (%). Grouped by request type.',
  })
  @ApiQuery({ name: 'from', required: false, type: String })
  @ApiQuery({ name: 'to', required: false, type: String })
  @ApiQuery({ name: 'type', required: false, type: String })
  @ApiResponse({ status: 200, type: SlaComplianceResponseDto })
  @ApiCommonErrors(401, 403)
  async getRequestSlaCompliance(
    @Query() query: DateRangeQueryDto,
  ): Promise<SlaComplianceResponseDto> {
    const { from, to } = await this.reportsService.resolveRange(query.from, query.to);
    const rows = await this.reportsService.getRequestSlaCompliance({ from, to, type: query.type });
    return { from: from.toISOString(), to: to.toISOString(), rows };
  }

  @Get('requests/queue')
  @ApiOperation({
    summary: 'Live queue depth by request type',
    description:
      'Current pending + in-review request counts by type. Includes "at-risk" count for items past their SLA deadline but not yet marked as breached.',
  })
  @ApiResponse({ status: 200, type: QueueDepthResponseDto })
  @ApiCommonErrors(401, 403)
  async getRequestQueueDepth(): Promise<QueueDepthResponseDto> {
    const rows = await this.reportsService.getRequestQueueDepth();
    return { asOf: new Date().toISOString(), rows };
  }

  @Get('requests/throughput')
  @ApiOperation({
    summary: 'Daily submission and resolution throughput',
    description:
      'Daily time series of submitted and resolved request counts. Useful for tracking backlog burn rate and workload trends.',
  })
  @ApiQuery({ name: 'from', required: false, type: String })
  @ApiQuery({ name: 'to', required: false, type: String })
  @ApiQuery({ name: 'type', required: false, type: String })
  @ApiResponse({ status: 200, type: ThroughputResponseDto })
  @ApiCommonErrors(401, 403)
  async getRequestThroughput(@Query() query: DateRangeQueryDto): Promise<ThroughputResponseDto> {
    const { from, to } = await this.reportsService.resolveRange(query.from, query.to);
    const points = await this.reportsService.getRequestThroughput({ from, to, type: query.type });
    return { from: from.toISOString(), to: to.toISOString(), points };
  }

  // ─── Compliance ─────────────────────────────────────────────────────────────

  @Get('compliance/findings')
  @ApiOperation({
    summary: 'Compliance findings summary by severity',
    description:
      'Open, in-remediation, and resolved compliance finding counts grouped by severity for the given period.',
  })
  @ApiQuery({ name: 'from', required: false, type: String })
  @ApiQuery({ name: 'to', required: false, type: String })
  @ApiResponse({ status: 200, type: FindingsSummaryResponseDto })
  @ApiCommonErrors(401, 403)
  async getComplianceFindingsSummary(
    @Query() query: DateRangeOnlyQueryDto,
  ): Promise<FindingsSummaryResponseDto> {
    const { from, to } = await this.reportsService.resolveRange(query.from, query.to);
    const rows = await this.reportsService.getComplianceFindingsSummary({ from, to });
    return { from: from.toISOString(), to: to.toISOString(), rows };
  }

  // ─── Assets ──────────────────────────────────────────────────────────────────

  @Get('assets/utilization')
  @ApiOperation({
    summary: 'Asset utilization by type',
    description:
      'Current asset stock counts (in_stock / assigned / retired / in_repair) grouped by asset type, with utilization percentage.',
  })
  @ApiResponse({ status: 200, type: AssetUtilizationResponseDto })
  @ApiCommonErrors(401, 403)
  async getAssetUtilization(): Promise<AssetUtilizationResponseDto> {
    const rows = await this.reportsService.getAssetUtilization();
    return { asOf: new Date().toISOString(), rows };
  }

  // ─── Workforce ───────────────────────────────────────────────────────────────

  @Get('workforce/leave')
  @ApiOperation({
    summary: 'Leave request summary by type and status',
    description: 'Leave request counts grouped by leave type and status for the given period.',
  })
  @ApiQuery({ name: 'from', required: false, type: String })
  @ApiQuery({ name: 'to', required: false, type: String })
  @ApiResponse({ status: 200, type: LeaveSummaryResponseDto })
  @ApiCommonErrors(401, 403)
  async getLeaveSummary(@Query() query: DateRangeOnlyQueryDto): Promise<LeaveSummaryResponseDto> {
    const { from, to } = await this.reportsService.resolveRange(query.from, query.to);
    const rows = await this.reportsService.getLeaveSummary({ from, to });
    return { from: from.toISOString(), to: to.toISOString(), rows };
  }

  @Get('workforce/overtime')
  @ApiOperation({
    summary: 'Overtime summary by status',
    description:
      'Overtime entry counts, total hours, and average hours grouped by approval status for the given period.',
  })
  @ApiQuery({ name: 'from', required: false, type: String })
  @ApiQuery({ name: 'to', required: false, type: String })
  @ApiResponse({ status: 200, type: OvertimeSummaryResponseDto })
  @ApiCommonErrors(401, 403)
  async getOvertimeSummary(
    @Query() query: DateRangeOnlyQueryDto,
  ): Promise<OvertimeSummaryResponseDto> {
    const { from, to } = await this.reportsService.resolveRange(query.from, query.to);
    const rows = await this.reportsService.getOvertimeSummary({ from, to });
    return { from: from.toISOString(), to: to.toISOString(), rows };
  }
}
