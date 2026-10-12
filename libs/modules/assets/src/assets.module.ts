import { Module } from '@nestjs/common';
import { AuditModule } from '@modules/audit';
import { EmployeesModule } from '@modules/identity';
import { AssetService } from './application/asset.service';
import { AssetsController } from './interface/http/assets.controller';
import { AssetDrizzleRepository } from './infrastructure/persistence/asset.drizzle-repository';
import { ASSET_REPOSITORY } from './domain/ports/asset.repository';

@Module({
  imports: [AuditModule, EmployeesModule],
  controllers: [AssetsController],
  providers: [AssetService, { provide: ASSET_REPOSITORY, useClass: AssetDrizzleRepository }],
  exports: [AssetService],
})
export class AssetsModule {}
