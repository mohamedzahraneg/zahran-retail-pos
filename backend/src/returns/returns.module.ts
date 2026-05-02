import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ReturnEntity } from './entities/return.entity';
import { ReturnsService } from './returns.service';
import { ReturnsController } from './returns.controller';
import { ReturnsAnalyticsService } from './returns-analytics.service';
import { ReturnsAnalyticsController } from './returns-analytics.controller';
import { AuditModule } from '../audit/audit.module';

@Module({
  // PR-FIN-RETURNS-UX-1C — `AuditModule` provides `AuditService` for
  // the cancel endpoint's activity-log write (`action='void'`,
  // `entity='return'`). Existing approve/refund/reject paths don't
  // currently audit-log; that's an unrelated gap left for later.
  imports: [TypeOrmModule.forFeature([ReturnEntity]), AuditModule],
  providers: [ReturnsService, ReturnsAnalyticsService],
  controllers: [ReturnsAnalyticsController, ReturnsController],
  exports: [ReturnsService, ReturnsAnalyticsService],
})
export class ReturnsModule {}
