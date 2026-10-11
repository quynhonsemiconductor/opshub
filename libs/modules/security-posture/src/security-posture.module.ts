import { Module } from '@nestjs/common';
import { GraphTasksModule } from '@modules/graph';
import { SecureScoreQueryService } from './application/secure-score-query.service';
import { SecurityPostureController } from './interface/http/security-posture.controller';

@Module({
  imports: [GraphTasksModule],
  controllers: [SecurityPostureController],
  providers: [SecureScoreQueryService],
  exports: [SecureScoreQueryService],
})
export class SecurityPostureModule {}
