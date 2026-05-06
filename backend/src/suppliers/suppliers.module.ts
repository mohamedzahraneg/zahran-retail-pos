import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SupplierEntity } from './entities/supplier.entity';
import { SuppliersService } from './suppliers.service';
import { SuppliersController } from './suppliers.controller';
// PR-FIX-IDEMPOTENCY-APPROVE-FAMILY (Sprint 4 / PR-11F) — wire the
// existing Redis-backed IdempotencyInterceptor + cache service so
// `@UseInterceptors(IdempotencyInterceptor)` on
// `SuppliersController.pay` (general supplier payment — INSERT
// supplier_payments + post JE + CT) can resolve them. This is the
// ONLY new module wiring in PR-11F; the other 7 affected modules
// (accounting, pos, returns, shifts, attendance, purchases,
// chart-of-accounts) already provide the interceptor from prior
// PRs in this sprint.
import { IdempotencyCacheService } from '../common/cache/idempotency-cache.service';
import { IdempotencyInterceptor } from '../common/interceptors/idempotency.interceptor';

@Module({
  imports: [TypeOrmModule.forFeature([SupplierEntity])],
  providers: [
    SuppliersService,
    IdempotencyCacheService,
    IdempotencyInterceptor,
  ],
  controllers: [SuppliersController],
  exports: [SuppliersService],
})
export class SuppliersModule {}
