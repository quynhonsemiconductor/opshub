import { Module } from '@nestjs/common';
import { AppConfigModule as SharedConfigModule } from '@quynhonsemiconductor/platform-runtime';
import { EnvSchema } from './env.schema';
import { ApiConfigService, AppConfigService, WorkerConfigService } from './app-config.service';

/**
 * Validation and `@Global()` registration come from
 * `@quynhonsemiconductor/platform-runtime`; the schema and the service are opshub's.
 *
 * Kept as a named module rather than calling `forRoot` at the import site so
 * `AppModule`'s imports list is unchanged.
 */
@Module({
  imports: [SharedConfigModule.forRoot({ schema: EnvSchema, service: AppConfigService })],
  // The role-typed views are plain wrappers over the same validated environment.
  providers: [ApiConfigService, WorkerConfigService],
  exports: [SharedConfigModule, ApiConfigService, WorkerConfigService],
})
export class AppConfigModule {}
