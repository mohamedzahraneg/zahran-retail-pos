import { Module } from '@nestjs/common';
import { RecurringExpensesService } from './recurring-expenses.service';
import { RecurringExpensesController } from './recurring-expenses.controller';
import { RecurringExpensesScheduler } from './recurring-expenses.scheduler';
// PR-FIX-IDEMPOTENCY-DEFERRED-APPROVE-FAMILY (Sprint 4 / PR-11F-bis)
// Wire the existing Redis-backed IdempotencyInterceptor + cache service
// so `@UseInterceptors(IdempotencyInterceptor)` on
// `RecurringExpensesController.runOne` and `processDue` can resolve
// them. PR-11F deferred this wiring to avoid expanding the approve-
// family PR's blast radius.
import { IdempotencyCacheService } from '../common/cache/idempotency-cache.service';
import { IdempotencyInterceptor } from '../common/interceptors/idempotency.interceptor';
// PR-A — Recurring Expenses v2.  AccountingModule exports
// ExpenseApprovalService; importing the module (rather than re-
// declaring the provider) keeps it a singleton across the app and
// reuses the same DataSource the rest of the accounting flow uses.
// Necessary so runOne() can spawn `expense_approvals` rows when
// `require_approval=true`, mirroring the normal createExpense flow.
import { AccountingModule } from '../accounting/accounting.module';

@Module({
  imports: [AccountingModule],
  providers: [
    RecurringExpensesService,
    RecurringExpensesScheduler,
    IdempotencyCacheService,
    IdempotencyInterceptor,
  ],
  controllers: [RecurringExpensesController],
  exports: [RecurringExpensesService],
})
export class RecurringExpensesModule {}
