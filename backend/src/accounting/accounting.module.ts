import { Module } from '@nestjs/common';
import { AccountingController } from './accounting.controller';
import { AccountingService } from './accounting.service';
import { ExpenseApprovalService } from './approval.service';
import { CostAccountResolver } from './cost-account-resolver.service';
import { CostReconciliationService } from './cost-reconciliation.service';
// PR-AUDIT-IDEMPOTENCY-ACCOUNTING-EXPENSES — reuse the same Redis-
// backed interceptor + cache shipped in PR #275 (POS) and #277
// (cash-desk transfer). Registered as providers here so the
// @UseInterceptors decorators on createExpense() + createDailyExpense()
// can resolve them. No CommonModule refactor in this PR (minimal scope).
import { IdempotencyCacheService } from '../common/cache/idempotency-cache.service';
import { IdempotencyInterceptor } from '../common/interceptors/idempotency.interceptor';

// One-shot bootstrap services removed after completion:
//   * ReclassifyTo1123Service (PR #66/#67) — posted JE-2026-000171..174
//   * EmployeeLedgerReset202604Service (PR #73) — posted JE-000176..177
// Engine idempotency on (reference_type, reference_id) made both
// permanent no-ops on subsequent boots. Historical JEs preserved.

@Module({
  controllers: [AccountingController],
  providers: [
    AccountingService,
    ExpenseApprovalService,
    CostAccountResolver,
    CostReconciliationService,
    IdempotencyCacheService,
    IdempotencyInterceptor,
  ],
  exports: [
    AccountingService,
    ExpenseApprovalService,
    CostAccountResolver,
    CostReconciliationService,
  ],
})
export class AccountingModule {}
