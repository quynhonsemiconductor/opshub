import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';
import { ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
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

  /**
   * Liveness probe for Kubernetes — is the process alive?
   *
   * SERVED AT `/livez`, NOT `/v1/livez` — the exclusion is in
   * `apps/api/src/bootstrap/app.bootstrap.ts`. `gitops/charts/qnsc-service`
   * hardcodes the liveness path (§9j: it is deliberately NOT a per-service
   * value), and `gitops/platform/policy/admission.yaml` DENIES any Deployment
   * whose liveness path is not exactly `/livez`. So a prefixed path is not a
   * lesser option, it is a rejected manifest — and a missing route is a 404, a
   * restarting container and CrashLoopBackOff.
   *
   * It DUPLICATES `healthz` rather than replacing it because `/v1/healthz` is
   * load-bearing on the ECS path — the ALB target group and the Dockerfile
   * HEALTHCHECK both point at it — and §17b runs both platforms at once. They
   * collapse into one at Phase 5.
   *
   * ⚠ NEVER TOUCH A DEPENDENCY HERE. §9j: a liveness probe that checks the
   * database turns a slowdown into an outage, because Kubernetes kills every
   * replica of every service at once. `readyz` is where dependencies belong.
   */
  // EXCLUDED FROM THE OPENAPI DOCUMENT. `/livez` is a contract with the kubelet,
  // not with API consumers: nothing generates a client for it and nothing calls it
  // from a browser. Leaving it in the schema also broke CI — both this repo and
  // rova diff the committed generated web client against the captured spec, so a
  // new path there is a failing build until someone regenerates a client for a
  // route no client will ever use. `/metrics` in qnsc-kb is excluded for the same
  // reason.
  @ApiExcludeEndpoint()
  @Get('livez')
  @Public()
  @SkipRateLimit()
  @ApiOperation({ summary: 'Kubernetes liveness probe — process only, no dependencies' })
  livez() {
    return { status: 'ok' };
  }

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
