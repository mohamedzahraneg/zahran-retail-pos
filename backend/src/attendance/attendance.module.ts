import { Module } from '@nestjs/common';
import { AttendanceService } from './attendance.service';
import { AttendanceController } from './attendance.controller';
import { EmployeesModule } from '../employees/employees.module';
import { AccountingModule } from '../accounting/accounting.module';
// PR-FIX-IDEMPOTENCY-DEFERRED-VOID-CANCEL-ROUTES (Sprint 4 / PR-11E-bis)
// Wire the existing Redis-backed IdempotencyInterceptor + cache service
// so `@UseInterceptors(IdempotencyInterceptor)` on
// `AttendanceController.adminVoidAccrual` can resolve them. Same minimal
// pattern used in CashDeskModule (PR #277), ShiftsModule (PR #306),
// Stock/Purchases/StockTransfers (PR #307), ReturnsModule (PR #308),
// EmployeesModule (PR #309). PR-11E deferred this wiring to avoid
// expanding the void/cancel/refund family PR's scope.
import { IdempotencyCacheService } from '../common/cache/idempotency-cache.service';
import { IdempotencyInterceptor } from '../common/interceptors/idempotency.interceptor';

@Module({
  // EmployeesModule → EmployeesService.recordSettlement (for the 213
  // portion of pay-wage) + addBonus (for bonus classification).
  // AccountingModule → AccountingService.createDailyExpense (is_advance=TRUE)
  // for the advance classification. Both paths run through
  // FinancialEngine; no new accounting logic in AttendanceService.
  imports: [EmployeesModule, AccountingModule],
  providers: [
    AttendanceService,
    IdempotencyCacheService,
    IdempotencyInterceptor,
  ],
  controllers: [AttendanceController],
  exports: [AttendanceService],
})
export class AttendanceModule {}
