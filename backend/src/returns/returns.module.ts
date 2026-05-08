import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ReturnEntity } from './entities/return.entity';
import { ReturnsService } from './returns.service';
import { ReturnsController } from './returns.controller';
import { ReturnsAnalyticsService } from './returns-analytics.service';
import { ReturnsAnalyticsController } from './returns-analytics.controller';
import { ReturnsAuditService } from './returns-audit.service';
import { AuditModule } from '../audit/audit.module';
// PR-FIX-IDEMPOTENCY-EXCHANGES-INVOICE-EDITS (Sprint 4 / PR-11C) —
// wire the existing Redis-backed IdempotencyInterceptor + cache
// service so `@UseInterceptors(IdempotencyInterceptor)` on
// `ReturnsController.exchange` can resolve them. Same minimal
// pattern used in CashDeskModule (PR #277), ShiftsModule (PR #306),
// and the stock + purchases + stock-transfers modules in PR #307.
import { IdempotencyCacheService } from '../common/cache/idempotency-cache.service';
import { IdempotencyInterceptor } from '../common/interceptors/idempotency.interceptor';

@Module({
  // PR-FIN-RETURNS-UX-1C — `AuditModule` provides `AuditService` for
  // the cancel endpoint's activity-log write (`action='void'`,
  // `entity='return'`). Existing approve/refund/reject paths don't
  // currently audit-log; that's an unrelated gap left for later.
  imports: [TypeOrmModule.forFeature([ReturnEntity]), AuditModule],
  providers: [
    ReturnsService,
    ReturnsAnalyticsService,
    ReturnsAuditService,
    IdempotencyCacheService,
    IdempotencyInterceptor,
  ],
  controllers: [ReturnsAnalyticsController, ReturnsController],
  exports: [ReturnsService, ReturnsAnalyticsService, ReturnsAuditService],
})
export class ReturnsModule {}
