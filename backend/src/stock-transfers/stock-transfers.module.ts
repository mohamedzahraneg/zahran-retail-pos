import { Module } from '@nestjs/common';
import { StockTransfersService } from './stock-transfers.service';
import { StockTransfersController } from './stock-transfers.controller';
// PR-FIX-IDEMPOTENCY-STOCK-INVENTORY-PATHS (Sprint 4 / PR-11B) — wire
// the existing Redis-backed IdempotencyInterceptor + cache service so
// `@UseInterceptors(IdempotencyInterceptor)` on the 3 lifecycle
// handlers (create / ship / receive) can resolve them. Same minimal
// pattern used in CashDeskModule (PR #277), ShiftsModule (PR #306),
// and the sibling stock + purchases modules in this PR.
import { IdempotencyCacheService } from '../common/cache/idempotency-cache.service';
import { IdempotencyInterceptor } from '../common/interceptors/idempotency.interceptor';

@Module({
  providers: [
    StockTransfersService,
    IdempotencyCacheService,
    IdempotencyInterceptor,
  ],
  controllers: [StockTransfersController],
  exports: [StockTransfersService],
})
export class StockTransfersModule {}
