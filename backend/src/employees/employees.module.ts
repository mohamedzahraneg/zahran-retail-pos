import { Module } from '@nestjs/common';
import { EmployeesController } from './employees.controller';
import { EmployeesService } from './employees.service';
import { PayrollController } from './payroll.controller';
// PR-FIX-IDEMPOTENCY-EMPLOYEE-PAYROLL-P0 (Sprint 4 / PR-11D) — wire
// the existing Redis-backed IdempotencyInterceptor + cache service so
// `@UseInterceptors(IdempotencyInterceptor)` on the 4 P0 employee/
// payroll financial routes (addSettlement, addBonus, addDeduction in
// EmployeesController and create in PayrollController) can resolve
// them. Same minimal pattern used in CashDeskModule (PR #277),
// ShiftsModule (PR #306), Stock/Purchases/StockTransfers (PR #307),
// and ReturnsModule (PR #308).
import { IdempotencyCacheService } from '../common/cache/idempotency-cache.service';
import { IdempotencyInterceptor } from '../common/interceptors/idempotency.interceptor';

@Module({
  // PayrollController shares the same module as EmployeesController
  // (no new module — extends existing per user constraint).
  controllers: [EmployeesController, PayrollController],
  providers: [
    EmployeesService,
    IdempotencyCacheService,
    IdempotencyInterceptor,
  ],
  exports: [EmployeesService],
})
export class EmployeesModule {}
