import { Module } from '@nestjs/common';
import { InventoryCountsService } from './inventory-counts.service';
import { InventoryCountsController } from './inventory-counts.controller';
// PR-FIX-IDEMPOTENCY-DEFERRED-APPROVE-FAMILY (Sprint 4 / PR-11F-bis)
// Wire the existing Redis-backed IdempotencyInterceptor + cache service
// so `@UseInterceptors(IdempotencyInterceptor)` on
// `InventoryCountsController.finalize` can resolve them. PR-11F
// deferred this wiring to avoid expanding the approve-family PR's
// blast radius.
import { IdempotencyCacheService } from '../common/cache/idempotency-cache.service';
import { IdempotencyInterceptor } from '../common/interceptors/idempotency.interceptor';

@Module({
  providers: [
    InventoryCountsService,
    IdempotencyCacheService,
    IdempotencyInterceptor,
  ],
  controllers: [InventoryCountsController],
  exports: [InventoryCountsService],
})
export class InventoryCountsModule {}
