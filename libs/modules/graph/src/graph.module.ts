import { Module } from '@nestjs/common';
import { DeviceSyncService } from './application/device-sync.service';
import { EntraAccountService } from './application/entra-account.service';
import { GraphSyncCron } from './application/graph-sync.cron';
import {
  GraphAccountRelayService,
  GraphScanRelayService,
} from './application/graph-task-relay.service';
import { SecureScoreSyncService } from './application/secure-score-sync.service';
import { ShadowItScanService } from './application/shadow-it-scan.service';
import { GraphClientService } from './graph-client.service';

/**
 * Everything that can talk to Microsoft Graph. IMPORTED BY THE WORKER ONLY (`apps/worker`).
 *
 * The API imports `GraphTasksModule` instead and can only ask for work. `test/graph-client-single-source`
 * fails the build if anything outside this module builds a Graph client or imports this module from
 * the API app.
 */
@Module({
  providers: [
    GraphClientService,
    EntraAccountService,
    DeviceSyncService,
    ShadowItScanService,
    SecureScoreSyncService,
    GraphAccountRelayService,
    GraphScanRelayService,
    GraphSyncCron,
  ],
})
export class GraphModule {}
