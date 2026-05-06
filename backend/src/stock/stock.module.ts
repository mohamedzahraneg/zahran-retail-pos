import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StockEntity } from './entities/stock.entity';
import { WarehouseEntity } from './entities/warehouse.entity';
import { StockService } from './stock.service';
import { StockController } from './stock.controller';
// PR-FIX-IDEMPOTENCY-STOCK-INVENTORY-PATHS (Sprint 4 / PR-11B) — wire
// the existing Redis-backed IdempotencyInterceptor + cache service so
// `@UseInterceptors(IdempotencyInterceptor)` on `StockController.adjust`
// can resolve them. Same minimal pattern used in CashDeskModule (PR
// #277) and ShiftsModule (PR #306).
import { IdempotencyCacheService } from '../common/cache/idempotency-cache.service';
import { IdempotencyInterceptor } from '../common/interceptors/idempotency.interceptor';

@Module({
  imports: [TypeOrmModule.forFeature([StockEntity, WarehouseEntity])],
  providers: [
    StockService,
    IdempotencyCacheService,
    IdempotencyInterceptor,
  ],
  controllers: [StockController],
  exports: [StockService],
})
export class StockModule {}
