import { Module } from '@nestjs/common';
import { ShiftsService } from './shifts.service';
import { ShiftsController } from './shifts.controller';
// PR-FIX-IDEMPOTENCY-DIRECT-CT-WRITES (Sprint 4 / PR-11A) — wire the
// existing Redis-backed IdempotencyInterceptor + cache service so the
// `@UseInterceptors(IdempotencyInterceptor)` decorator on
// `ShiftsController.adjustCount()` can resolve them. Same pattern as
// CashDeskModule (PR #277). No CommonModule refactor in this PR
// (minimal scope).
import { IdempotencyCacheService } from '../common/cache/idempotency-cache.service';
import { IdempotencyInterceptor } from '../common/interceptors/idempotency.interceptor';

@Module({
  providers: [
    ShiftsService,
    IdempotencyCacheService,
    IdempotencyInterceptor,
  ],
  controllers: [ShiftsController],
  exports: [ShiftsService],
})
export class ShiftsModule {}
