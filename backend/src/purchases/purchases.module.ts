import { Module } from '@nestjs/common';
import { PurchasesService } from './purchases.service';
import { PurchasesController } from './purchases.controller';
// PR-FIX-IDEMPOTENCY-STOCK-INVENTORY-PATHS (Sprint 4 / PR-11B) — wire
// the existing Redis-backed IdempotencyInterceptor + cache service so
// `@UseInterceptors(IdempotencyInterceptor)` on
// `PurchasesController.receive` can resolve them. Same minimal
// pattern used in CashDeskModule (PR #277), ShiftsModule (PR #306),
// and the sibling stock + stock-transfers modules in this PR.
import { IdempotencyCacheService } from '../common/cache/idempotency-cache.service';
import { IdempotencyInterceptor } from '../common/interceptors/idempotency.interceptor';

@Module({
  providers: [
    PurchasesService,
    IdempotencyCacheService,
    IdempotencyInterceptor,
  ],
  controllers: [PurchasesController],
  exports: [PurchasesService],
})
export class PurchasesModule {}
