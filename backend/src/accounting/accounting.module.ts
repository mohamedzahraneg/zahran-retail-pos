import { Module } from '@nestjs/common';
import { AccountingController } from './accounting.controller';
import { AccountingService } from './accounting.service';
import { ExpenseApprovalService } from './approval.service';
import { CostAccountResolver } from './cost-account-resolver.service';
import { CostReconciliationService } from './cost-reconciliation.service';

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
  ],
  exports: [
    AccountingService,
    ExpenseApprovalService,
    CostAccountResolver,
    CostReconciliationService,
  ],
})
export class AccountingModule {}
