import { Module } from '@nestjs/common';
import { CashDeskService } from './cash-desk.service';
import { CashDeskController } from './cash-desk.controller';
import { CashboxGlDriftHelper } from './cashbox-gl-drift.helper';
// PR-AUDIT-IDEMPOTENCY-CASH-DESK-TRANSFER — reuse the same Redis-backed
// interceptor + cache shipped in PR #275 (POS pilot). Registered as
// providers here so the @UseInterceptors decorator on `transfer()` can
// resolve them. No CommonModule refactor in this PR (minimal scope).
import { IdempotencyCacheService } from '../common/cache/idempotency-cache.service';
import { IdempotencyInterceptor } from '../common/interceptors/idempotency.interceptor';

@Module({
  providers: [
    CashDeskService,
    CashboxGlDriftHelper,
    IdempotencyCacheService,
    IdempotencyInterceptor,
  ],
  controllers: [CashDeskController],
  exports: [CashDeskService],
})
export class CashDeskModule {}
