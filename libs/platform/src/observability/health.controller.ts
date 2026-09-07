import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { sql } from 'drizzle-orm';
import { Public } from '../auth/decorators';
import { SkipRateLimit } from '../rate-limit/rate-limit.decorator';
import { CacheService } from '@quynhonsemiconductor/platform-cache';
import { InjectDrizzle } from '../database/drizzle.provider';
import type { DrizzleDB } from '../database/drizzle.provider';

@ApiTags('health')
@Controller()
@SkipRateLimit() // K8s probes fire every 10-30 s — must not consume rate-limit quota
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly cache: CacheService,
    @InjectDrizzle() private readonly db: DrizzleDB,
  ) {}

  /** Liveness probe — is the process alive? */
  @Get('healthz')
  @Public()
  @ApiOperation({ summary: 'Liveness probe' })
  healthz() {
    return { status: 'ok' };
  }

  /** Readiness probe — can we serve traffic? (DB + cache reachable) */
  @Get('readyz')
  @Public()
  @HealthCheck()
  @ApiOperation({ summary: 'Readiness probe — checks database and cache connectivity' })
  async readyz() {
    return this.health.check([
      async () => {
        try {
          await this.db.execute(sql`SELECT 1`);
          return { postgres: { status: 'up' } };
        } catch (e) {
          return { postgres: { status: 'down', error: String(e) } };
        }
      },
      async () => {
        if (!this.cache.isAvailable) {
          return { redis: { status: 'up', note: 'disabled — REDIS_URL not configured' } };
        }
        try {
          const probeKey = '__readyz_probe__';
          await this.cache.set(probeKey, '1', 5);
          const val = await this.cache.get(probeKey);
          await this.cache.del(probeKey);
          if (val !== '1') throw new Error('probe read mismatch');
          return { redis: { status: 'up' } };
        } catch (e) {
          return { redis: { status: 'down', error: String(e) } };
        }
      },
    ]);
  }
}
